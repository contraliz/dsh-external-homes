# DSH External Homes

An installable DSH Web panel for browsing sessions from DSH homes outside the running harness home. It adds an **External workspaces** panel where you can register additional DSH home directories at runtime, browse their conversations grouped by project directory, and open any conversation in the normal DSH conversation view.

A DSH home is the directory that contains a `sessions/` folder — normally `~/.dsh`, but any directory created by `DSH_HOME=/path dsh` works. The plugin reads `<home>/sessions` through DSH's JSONL persistence API and supports the backend's Zstandard-compressed and raw JSONL generations. The browsed homes are never written to.

## Install

Install the published GitHub package:

```powershell
dsh plugin --profile web add github:contraliz/dsh-external-homes
```

Or, from a local checkout, install the checkout directory:

```powershell
dsh plugin --profile web add .\dsh-external-homes
```

Use the profile you normally launch if it is not `web` — for example `desktop` in the Desktop app. The package declares a DSH `0.2.x` compatibility range. A linked local checkout is loaded by the running DSH process, so restart DSH after changing this plugin's code.

## Register homes at runtime

Open the **External workspaces** panel in the sidebar, type an absolute path such as `D:\work\other-dsh-home`, and choose **Add DSH home**. The host checks that the folder exists and that its sessions tree is readable, then saves the registration.

Registered homes survive restarts. They are kept in a small JSON registry:

- `$DSH_HOME/external-homes.json` by default.
- Set `registryFile` to an absolute path to use another location.

Only homes registered through the panel can be removed there. Homes supplied by the profile configuration are marked **Configured** and must be changed in the profile patch instead.

If the registry file is damaged, the panel shows a warning, keeps the last homes it could read for the current run, and preserves the damaged file as `external-homes.json.corrupt-<timestamp>` the next time you add a home. Fix or delete the file to start clean.

## Open a conversation

Each home section lists its conversations grouped by the project directory recorded in the session header, newest first. Choose a conversation to open it in DSH's normal conversation view, with the usual transcript, title, composer, and sidebar behavior.

Because the normal viewer reads sessions from the running DSH home, opening an external conversation first copies its event log into the current DSH home:

- The copy is stored as an ordinary session, so DSH can list, title, search, and render it normally.
- The copy uses a deterministic identity derived from the external home and session id, so opening the same conversation again reuses the same copy instead of creating another.
- The copy's workspace is the external home path, so it appears under that workspace in the main Workspaces list (or under **Ungrouped** until the workspace exists).
- The external home is only read. Later changes to the external session are not synced into an existing copy.
- The composer is available on the copy, so continuing it creates a normal DSH conversation in the current home. The copy is independent of the external session from that point on.

A conversation larger than 50,000 events is refused rather than copied, to bound memory use.

## Configure seed homes

Edit the selected profile's `cordis.patch.yml` (for the standard Web profile, `$DSH_HOME/profiles/web/cordis.patch.yml`) and update the `external-homes` row:

```yaml
- id: external-homes
  name: dsh-external-homes
  config:
    homes:
      - 'C:/Users/you/.dsh'
      - 'D:/work/other-dsh-home'
    allowRegistration: true
```

| Field | Default | Meaning |
|---|---|---|
| `homes` | `[]` | Absolute DSH home paths available from startup. They cannot be removed in the panel. |
| `registryFile` | `$DSH_HOME/external-homes.json` | Absolute path of the runtime registration file. |
| `allowRegistration` | `true` | When `false`, the panel hides the add form and remove buttons. |

The row's `config` is replaced as a whole by a profile override, so keep every field you want in that list. Do not point at a `sessions` subdirectory; the plugin derives it from each DSH home path. A home without a `sessions` folder appears with an empty status and becomes browsable once DSH creates it.

## Storage safety

- Only explicitly configured or explicitly registered absolute paths are used. The plugin never reads `$DSH_HOME` from the environment to discover additional homes and never scans the filesystem for them.
- Registration resolves the real path, requires an existing directory, rejects duplicates (case-insensitively on Windows), and probes the sessions tree before saving. A path that is itself a `sessions` directory is rejected with a hint to register its parent.
- Listing resolves each home, derives its `sessions` child, and rejects a symlinked sessions root, symlinked entries, paths resolving outside that home, mixed raw/compressed generations, and unsupported flat-file layouts before listing or opening sessions.
- Opening a conversation reads the external log through a DSH persistence `read` handle, then creates a normal session in the current DSH home through `ctx.sessionPersistence`. The imported events pass the same storage validation as any other session.
- The API is an owner-only exact Fetch route at `POST /api/external-homes`. The Connection layer rejects unauthenticated and non-owner callers before the handler runs, and the handler accepts only a registered source id and a session id returned by that source's latest list.
- Session titles are read from the stored `session/title` event and rendered as inert text. No session content is evaluated, interpreted as markup, or used as a filesystem path.

As with DSH's path-based persistence backend, filesystem validation occurs immediately before API reads but cannot prevent a separate local process from replacing files between validation and the backend's path-based open. Use homes you control and avoid concurrent external changes while browsing.

## DSH references

- [Installable bundles and profile overrides](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
- [Session persistence API](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md)
- [JSONL storage formats and read-only migration behavior](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session/session-persistence-jsonl/README.md)
- [Web client panel slots](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar/README.md)
- [Connection RPC and exact Fetch routes](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/api-gateway.md)
