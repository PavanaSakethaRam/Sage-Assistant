# Sage Local Editor Bridge

Development-only local pairing shell. In a trusted local single-folder desktop window, run **Sage: Pair Local Editor**, enter Sage's one-use ticket, and confirm the matching folder/window challenge in both applications. Pairing shares no source and calls no model. Reloading or changing folders revokes pairing; reconnect explicitly with a fresh ticket.

Restricted Mode, remote/WSL/container/web, virtual and multi-root workspaces are unsupported. The bridge authenticates possession of a secret, not an OS-attested binary, and loopback traffic is not encrypted. Administrators, stolen tickets and malicious extensions in the same extension host remain outside this boundary.

No model integration, source picker, apply/save/test action or automatic browser opening is provided by this slice. The local publisher identifier does not claim Marketplace ownership. No installation or account connection is required for isolated development tests.
