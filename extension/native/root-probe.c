/* Fixed read-only local directory probe. No source files or environment are read. */
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#define INPUT_CAP 16384
static int input(char *path) {
  size_t n = fread(path, 1, INPUT_CAP + 1, stdin);
  if (ferror(stdin) || !feof(stdin) || n == 0 || n > INPUT_CAP) return 0;
  path[n] = 0;
  for (size_t i=0; i<n;) {
    unsigned char c=(unsigned char)path[i++]; uint32_t cp=c; int extra=0;
    if (c>=0xc2 && c<=0xdf) {cp=c&31;extra=1;}
    else if(c>=0xe0 && c<=0xef) {cp=c&15;extra=2;}
    else if(c>=0xf0 && c<=0xf4) {cp=c&7;extra=3;}
    else if(c>=0x80) return 0;
    if(i+(size_t)extra>n)return 0;
    for(int j=0;j<extra;j++){unsigned char d=(unsigned char)path[i++];if((d&0xc0)!=0x80)return 0;cp=(cp<<6)|(d&63);}
    if((extra==1&&cp<0x80)||(extra==2&&cp<0x800)||(extra==3&&cp<0x10000)||cp>0x10ffff||(cp>=0xd800&&cp<=0xdfff)||cp<32||(cp>=127&&cp<=159))return 0;
  }
  return 1;
}
#ifdef __APPLE__
#include <unistd.h>
#include <fcntl.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/mount.h>
static int check(char *path) {
  if(path[0]!='/' || (path[1] && path[strlen(path)-1]=='/'))return 0;
  int fd=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(fd<0)return 0;
  char *component=path+1; int ok=0;
  while(*component){
    char *end=strchr(component,'/');if(end)*end=0;
    if(!*component||!strcmp(component,".")||!strcmp(component,".."))goto done;
    int duplicate=dup(fd);if(duplicate<0)goto done;
    DIR *directory=fdopendir(duplicate);if(!directory){close(duplicate);goto done;}
    struct dirent *entry;int exact=0;
    while((entry=readdir(directory))!=NULL)if(!strcmp(entry->d_name,component)){exact=1;break;}
    closedir(directory);if(!exact)goto done;
    int next=openat(fd,component,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(next<0)goto done;
    close(fd);fd=next;
    if(!end)break;
    *end='/';component=end+1;
  }
  struct stat info;struct statfs volume;
  if(fstat(fd,&info)||fstatfs(fd,&volume)||!S_ISDIR(info.st_mode)||info.st_uid!=geteuid()||!(volume.f_flags&MNT_LOCAL))goto done;
  printf("SAGE_ROOT_V1 darwin %llu %llu\n",(unsigned long long)info.st_dev,(unsigned long long)info.st_ino);ok=1;
 done:close(fd);return ok;
}
#elif defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <aclapi.h>
#include <wchar.h>
#include <io.h>
#include <fcntl.h>
static int owned(HANDLE handle){
  PSID owner=NULL;PSECURITY_DESCRIPTOR descriptor=NULL;HANDLE token=NULL;DWORD size=0;int ok=0;TOKEN_USER *user=NULL;
  if(GetSecurityInfo(handle,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION,&owner,NULL,NULL,NULL,&descriptor)!=ERROR_SUCCESS)goto done;
  if(!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token))goto done;
  GetTokenInformation(token,TokenUser,NULL,0,&size);if(!size||size>65536)goto done;
  user=(TOKEN_USER*)malloc(size);if(!user||!GetTokenInformation(token,TokenUser,user,size,&size))goto done;
  ok=EqualSid(owner,user->User.Sid)!=0;
 done:if(user)free(user);if(token)CloseHandle(token);if(descriptor)LocalFree(descriptor);return ok;
}
static int check(char *input_path) {
 wchar_t path[INPUT_CAP+1],volume[INPUT_CAP+1],final[INPUT_CAP+5];
 int count=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,input_path,-1,path,INPUT_CAP+1);
 if(!count||count<4||path[0]<L'A'||path[0]>L'Z'||path[1]!=L':'||path[2]!=L'\\'||(count>4&&path[count-2]==L'\\'))return 0;
 for(int i=3;i<count-1;i++)if(path[i]==L'/'||path[i]==L':'||path[i]==L'~')return 0;
 HANDLE handle=INVALID_HANDLE_VALUE;int ok=0;
 for(int end=3;end<count;end++)if(path[end]==L'\\'||path[end]==0){
  wchar_t saved=path[end];path[end]=0;
  if(end>3){const wchar_t *name=wcsrchr(path,L'\\');name=name?name+1:path;size_t n=wcslen(name);
   if(!n||name[n-1]==L'.'||name[n-1]==L' '||!wcscmp(name,L".")||!wcscmp(name,L".."))goto done;
   WIN32_FIND_DATAW data;HANDLE find=FindFirstFileW(path,&data);if(find==INVALID_HANDLE_VALUE)goto done;
   int exact=!wcscmp(data.cFileName,name);FindClose(find);if(!exact)goto done;
  }
  DWORD attrs=GetFileAttributesW(path);if(attrs==INVALID_FILE_ATTRIBUTES||!(attrs&FILE_ATTRIBUTE_DIRECTORY)||(attrs&FILE_ATTRIBUTE_REPARSE_POINT))goto done;
  path[end]=saved;
 }
 handle=CreateFileW(path,FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,NULL);
 if(handle==INVALID_HANDLE_VALUE)goto done;
 BY_HANDLE_FILE_INFORMATION info;
 if(!GetFileInformationByHandle(handle,&info)||(info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)||!owned(handle))goto done;
 DWORD final_count=GetFinalPathNameByHandleW(handle,final,INPUT_CAP+5,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
 if(final_count==0||final_count>=INPUT_CAP+5||wcsncmp(final,L"\\\\?\\",4)||wcscmp(final+4,path))goto done;
 if(!GetVolumePathNameW(path,volume,INPUT_CAP+1)||GetDriveTypeW(volume)!=DRIVE_FIXED)goto done;
 printf("SAGE_ROOT_V1 win32 %lu %llu\n",(unsigned long)info.dwVolumeSerialNumber,((unsigned long long)info.nFileIndexHigh<<32)|info.nFileIndexLow);ok=1;
 done:if(handle!=INVALID_HANDLE_VALUE)CloseHandle(handle);return ok;
}
#else
#error Unsupported root probe platform
#endif
int main(int argc,char **argv){
#ifdef _WIN32
 if(_setmode(_fileno(stdin),_O_BINARY)==-1||_setmode(_fileno(stdout),_O_BINARY)==-1)return 1;
#endif
 char path[INPUT_CAP+2];
 if(argc!=2||strcmp(argv[1],"--check-root-v1")||!input(path)||!check(path))return 1;
 return fflush(stdout)==0?0:1;
}
