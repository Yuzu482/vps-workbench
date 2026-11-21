# Claude Code subscription terminal

`createStandaloneSubscriptionView(React)` in `subscription-view.mjs` returns a component that accepts the VPS Chat workbench's `active`, `activation`, and `subscriptionPreset` props. It uses the workbench's `.vc-*` styles. The exact Dev.14 xterm JavaScript and CSS are embedded in `vendor/xterm.mjs` and bundled by the renderer build. Include `vendor/LICENSE.xterm` with the distribution.

`createStandaloneSubscriptionHost({ port, stateRoot, workbenchRoot, executable, verifyTarget })` in `subscription-host.mjs` provides the existing loopback `GET /dsh-terminal-workbench/api/bootstrap` and `POST /dsh-terminal-workbench/api/rpc` handlers as `token` and `rpc`. Mount both behind the app's loopback authorization. Pass an existing app-owned `stateRoot` for receipts and the existing Chat storage directory as `workbenchRoot`. `verifyTarget(workbenchRoot, settings)` resolves to the Chat list operation's `targetId` digest for the supplied settings and pin copy. Call `dispose()` when the web server stops.

Stage these files from `test-artifacts/dsh-claude-subscription-interaction-20261120/verified-extract/package/ssh-prototype/bin/Debug/net10.0` together in a physical resources directory. Pass the absolute path to `DshSshBridge.exe` as `executable`.

- `DshSshBridge.exe`, `DshSshBridge.dll`, `DshSshBridge.deps.json`, `DshSshBridge.runtimeconfig.json`
- `RemoteSsh.Proxy.exe`, `RemoteSsh.Proxy.dll`, `RemoteSsh.Proxy.deps.json`, `RemoteSsh.Proxy.runtimeconfig.json`, `RemoteSsh.Core.dll`
- `helpers/RemoteNativeSafety.py`, `helpers/RemoteNativeSession.py`, `helpers/RemoteCodexPrivacy.py`, `helpers/RemoteCodexIsolate.py`, `helpers/sessions.py`, `helpers/remote_interactive.py`

The staged bridge uses the Windows OpenSSH client and the .NET 10 runtime. It runs its Python helpers via `python3` on the VPS. The local Chat SDK backend is a separate integration.

If `ssh-relay.json` exists in `workbenchRoot`, the bridge uses its SOCKS5 port and checks the remote-observed SSH source. An absent optional relay allows the Dev.14 direct route. Invalid relay files, disappearance during preflight, and receipts tied to another route are rejected.

The renderer and native host logic originate from `dsh-terminal-workbench-0.2.0-dev.14.tgz` in the same artifact directory. Run `node --test terminal/subscription-host.test.mjs` from the standalone app directory to exercise the adapter with an isolated fixture bridge.
