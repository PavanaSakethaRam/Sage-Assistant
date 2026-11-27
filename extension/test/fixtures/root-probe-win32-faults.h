/* Force-included only in the Windows helper built for coverage tests. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <wchar.h>

#define SAGE_UNPROFILED __attribute__((no_profile_instrument_function))

static SAGE_UNPROFILED BOOL probe_fault(const wchar_t *name) {
    wchar_t value[32];
    const DWORD capacity = (DWORD)(sizeof(value) / sizeof(value[0]));
    const DWORD length = GetEnvironmentVariableW(L"SAGE_ROOT_PROBE_FAULT", value, capacity);
    return length > 0 && length < capacity && wcscmp(value, name) == 0;
}

static SAGE_UNPROFILED DWORD probe_security_info(
    HANDLE handle, SE_OBJECT_TYPE kind, SECURITY_INFORMATION requested, PSID *owner,
    PSID *group, PACL *dacl, PACL *sacl, PSECURITY_DESCRIPTOR *descriptor
) {
    if (probe_fault(L"security-info")) return ERROR_ACCESS_DENIED;
    return GetSecurityInfo(handle, kind, requested, owner, group, dacl, sacl, descriptor);
}

static SAGE_UNPROFILED BOOL probe_token_info(
    HANDLE token, TOKEN_INFORMATION_CLASS kind, LPVOID buffer, DWORD capacity, PDWORD size
) {
    if (!buffer && probe_fault(L"empty-token")) {
        *size = 0;
        return FALSE;
    }
    if (!buffer && probe_fault(L"oversized-token")) {
        *size = 65537;
        return FALSE;
    }
    if (buffer && probe_fault(L"token-read")) return FALSE;
    return GetTokenInformation(token, kind, buffer, capacity, size);
}

static SAGE_UNPROFILED DWORD probe_final_path(
    HANDLE handle, LPWSTR path, DWORD capacity, DWORD flags
) {
    if (probe_fault(L"unresolved-path")) return 0;
    if (probe_fault(L"oversized-path")) return capacity + 1;
    if (probe_fault(L"unprefixed-path")) {
        path[0] = L'?';
        path[1] = 0;
        return 1;
    }
    const DWORD length = GetFinalPathNameByHandleW(handle, path, capacity, flags);
    if (length > 4 && length < capacity && probe_fault(L"different-path")) path[4] = L'?';
    return length;
}

#undef SAGE_UNPROFILED

#define GetSecurityInfo probe_security_info
#define GetTokenInformation probe_token_info
#define GetFinalPathNameByHandleW probe_final_path
