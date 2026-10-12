---
summary: "Choose which OpenAI routes select Codex and shape the deployment around them"
read_when:
  - You need to know which model refs select the Codex runtime
  - You want a fail-closed Codex requirement
  - You are configuring a mixed-provider fleet
title: "Codex routing and deployment"
sidebarTitle: "Routing and deployment"
---

Which effective routes select the Codex runtime, and the deployment shapes built on that policy. Part of the [Codex harness](/plugins/codex-harness) guide; [Where each section moved](/plugins/codex-harness#where-each-section-moved) lists every section.

## Routing and model selection

`openai/gpt-6-astra` defaults to `medium` reasoning effort through the shared
OpenAI provider policy when the account supports it. For OpenClaw-managed turns,
the resolved effort is sent in Codex `turn/start` requests,
including `collaborationMode.settings.reasoning_effort`, so the native thread
uses the same default as Control UI. Explicit thinking settings still win;
an existing session or agent configured for `high` stays at `high`. Threads
attached with native settings preserved retain their native effort.

Keep provider refs and runtime policy separate:

- Use `openai/gpt-*` for canonical OpenAI model selection. The prefix alone
  never selects Codex.
- With runtime unset or `auto`, only an exact official HTTPS Platform Responses
  or ChatGPT Responses route with no authored provider request override may
  select Codex implicitly. Valid model-scoped Fast-mode and cutoff controls do
  not count as authored request params.
- Do not use legacy Codex GPT refs in config; run `openclaw doctor --fix` to
  repair legacy refs and stale session route pins.
- `agentRuntime.id: "codex"` makes Codex a fail-closed requirement for a
  compatible route. It does not make an incompatible effective route compatible.
- `agentRuntime.id: "openclaw"` opts a provider or model into the embedded
  OpenClaw runtime when that is intentional.
- `/codex ...` controls native Codex app-server conversations from chat.
- ACP/acpx is a separate external harness path. Use it only when the user
  asks for ACP/acpx or an external harness adapter.

| User intent                                                | Use                                                                                                   |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Attach the current chat                                    | `/codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]`                    |
| Resume an existing Codex thread                            | `/codex resume <thread-id>`                                                                           |
| List or filter Codex threads                               | `/codex threads [filter]`                                                                             |
| Read or update the bound thread's native goal              | `/codex goal [status\|set <objective>\|pause\|resume\|block\|complete\|clear]`                        |
| List native Codex plugins                                  | `/codex plugins list`                                                                                 |
| Discover available native Codex marketplace plugins        | `/codex plugins available`                                                                            |
| Install and authorize one native Codex plugin              | `/codex plugins install <plugin>@<marketplace>`                                                       |
| Enable or disable a configured native Codex plugin         | `/codex plugins enable <name>`, `/codex plugins disable <name>`                                       |
| Resume a stored Codex CLI session as a paired-node turn    | `/codex sessions --host <node> [filter]`, then `/codex resume <session-id> --host <node> --bind here` |
| View non-archived Codex sessions across computers          | Enable Codex supervision and open **Codex Sessions**                                                  |
| Change the bound thread's model, fast-mode, or permissions | `/codex model <model>`, `/codex fast [on\|off\|status]`, `/codex permissions [default\|yolo\|status]` |
| Compact the current Codex session                          | `/codex compact`                                                                                      |
| Stop or steer the active turn                              | `/codex stop`, `/codex steer <text>`                                                                  |
| Detach the current binding                                 | `/codex detach` (alias `/codex unbind`)                                                               |
| Send Codex feedback only                                   | `/codex diagnostics [note]`                                                                           |
| Start an ACP/acpx task                                     | ACP/acpx session commands, not `/codex`                                                               |

| Use case                                        | Configure                                                                                                            | Verify                                  | Notes                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------- |
| Eligible OpenAI route with native Codex runtime | Exact official HTTPS Responses/ChatGPT route with no authored provider request override, plus enabled `codex` plugin | `/status` shows `Runtime: OpenAI Codex` | Valid Fast runtime controls do not disqualify this path    |
| Fail closed if Codex is unavailable             | Provider or model `agentRuntime.id: "codex"`                                                                         | Missing harness fails the turn          | Authored request overrides may still use declared fallback |
| Direct OpenAI API-key traffic through OpenClaw  | Provider or model `agentRuntime.id: "openclaw"` and normal OpenAI auth                                               | `/status` shows OpenClaw runtime        | Use only when OpenClaw is intentional                      |
| Legacy config                                   | legacy Codex GPT refs                                                                                                | `openclaw doctor --fix` rewrites it     | Do not write new config this way                           |
| ACP/acpx Codex adapter                          | ACP `sessions_spawn({ runtime: "acp" })`                                                                             | ACP task/session status                 | Separate from native Codex harness                         |

`agents.defaults.imageModel` follows the same prefix split. Use `openai/gpt-*`
for the normal OpenAI route and `codex/gpt-*` only when image understanding
should run through a bounded Codex app-server turn. Doctor rewrites legacy
Codex GPT refs to `openai/gpt-*`.

### Operator role model permissions

A role's [model policy](/gateway/operator-scopes#named-operator-roles) applies to
each native inference request, including retries, child turns, ordinary reviews,
native image and search requests, and compaction. OpenClaw checks the actual model against both the work's original
permissions and current policy before forwarding it. Verified catalog-to-native
model mappings remain valid. Removing a model cancels affected inference while
permitted work continues.

Reusing a native child does not attach its creator's permissions permanently.
A later turn with unambiguous source attribution uses its submitting operator's
authority after the earlier turn settles. With the native hook integration active,
sending input to an active turn requires the same original authority,
including follow-up requests that native execution can consume in that turn. Native
Guardian reviews and configured memory processing keep their existing service
authority, verified from native request provenance and their owning execution or
configured service.

Restricted runs require an OpenClaw-owned native inference route. Managed stdio
connections can retain HTTP or WebSocket Responses providers over public HTTPS;
already-owned native bindings can reuse that route.
Provider projection shares the connection's eight-route limit; excess providers
remain unavailable to restricted native restores, and selecting a new route after
capacity is reached requires a fresh managed native connection.
Custom providers need an explicit native `base_url`; query fields use the native
`query_params` table. Unowned attachments, native local-model providers,
AWS-signed requests, system-proxy profiles, custom native
certificate files, and proxy settings that cannot preserve both upstream routing
and private loopback access cannot establish this guarantee. OpenClaw rejects a
restricted run on those paths before starting it. Roles without a model policy
keep their existing native connection and optional-hook behavior. Introducing a
model policy while an unqualified operator execution is active cancels directly owned and otherwise
unambiguously bound work, including its unqualified children.

When staff run without a model policy and qualified native hooks are disabled or
unavailable, native execution can mix accepted input into an existing turn or
combine queued input from several senders into a new turn without preserving
unique sender attribution. Previously accepted unrestricted input that can no
longer be attributed uniquely may continue under the receiving execution's valid
authority after a contributing sender's authorization ends or becomes restricted.
A matching native root alone does not prove unique attribution. OpenClaw does not
interrupt independently authorized receiver work to guess which input it consumed.

This limitation does not exempt newly restricted work or revocation of a directly
or otherwise unambiguously bound source. Exact attribution requires the qualified
native hook integration. Visitor Access requires an explicit model policy; its
Codex runs require the qualified integration, so its normal restricted flow cannot
enter this optional staff configuration.

## Deployment patterns

### Basic Codex deployment

Use the quickstart config for an OpenAI model whose effective official HTTPS
route is eligible to select Codex implicitly:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-6-astra",
    },
  },
}
```

### Mixed provider deployment

Configure a Claude `main` agent and add a named Codex agent:

```json5
{
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
  agents: {
    ownership: "explicit",
    defaults: {
      model: "anthropic/claude-opus-4-6",
    },
    entries: {
      main: {
        model: "anthropic/claude-opus-4-6",
      },
      codex: {
        name: "Codex",
        model: "openai/gpt-6-astra",
      },
    },
  },
}
```

This explicit fleet has no default agent; target `main` or `codex` with a session, `--agent`, or binding. The `main` agent uses its normal provider path. The `codex` agent uses Codex app-server when its effective OpenAI route remains compatible; add explicit model-scoped `agentRuntime.id: "codex"` when that should be a fail-closed requirement.

### Fail-closed Codex deployment

An eligible exact official HTTPS OpenAI route can resolve to Codex when the
bundled plugin is available. Add explicit runtime policy for a written
fail-closed rule:

```json5
{
  models: {
    providers: {
      openai: {
        agentRuntime: {
          id: "codex",
        },
      },
    },
  },
  agents: {
    defaults: {
      model: "openai/gpt-6-astra",
    },
  },
  plugins: {
    entries: {
      codex: {
        enabled: true,
      },
    },
  },
}
```

With Codex forced, OpenClaw fails early if the plugin is disabled, the app-server
is too old or cannot start, or route/auth support is rejected without a declared
fallback. Authored request overrides may instead use the
[selection-time OpenClaw fallback](/concepts/agent-runtimes#runtime-selection)
that preserves the exact request. Once Codex starts, its failures are not replayed
through OpenClaw.

### Configured Responses gateways

An explicitly selected Codex runtime can use an operator-configured API-key
Responses gateway, including a private HTTP endpoint. Automatic selection for a
custom endpoint continues to prefer the OpenClaw runtime. Use the canonical
`openai` provider, an explicit `openai-responses` adapter, and the default managed
local app-server with its isolated agent home:

API-key isolated completions use OpenClaw's existing host-prepared Responses
transport, retaining the exact configured gateway and current model permission.
Detached native bounded turns, including settled-turn finalization, do not receive
retained host source authority. They reject custom prepared Responses routes
before creating an app-server client or thread. Official native routes keep their
existing bounded-turn behavior.

```json5
{
  models: {
    providers: {
      openai: {
        api: "openai-responses",
        baseUrl: "http://192.168.20.10:8317/v1",
        apiKey: { source: "env", provider: "default", id: "CUSTOM_RESPONSES_API_KEY" },
        agentRuntime: { id: "codex" },
        models: [
          { id: "proxy-model", name: "Gateway model", contextWindow: 200000, maxTokens: 8192 },
        ],
      },
    },
  },
  agents: { defaults: { model: "openai/proxy-model" } },
  plugins: { entries: { codex: { enabled: true } } },
}
```

OpenClaw installs the exact prepared destination in native startup configuration
before initialization or API-key login. The native process uses a custom
Responses provider with OpenAI backend routes, WebSockets, standalone search,
and native account model discovery disabled. Configured provider rows remain
authoritative. No default OpenAI endpoint is substituted for this route.

The existing parent-local inference relay retains the fixed upstream and current
model authority. Its private-network exception covers only the authored origin;
redirects and native provider changes are rejected. OpenClaw dynamic tools keep
their normal tool policy. Resume, compaction, and host-owned side questions retain
the same prepared route.

This route requires a prepared API key and managed local stdio. Remote app-server
connections, user-scoped native accounts, subscription credentials, URL credentials,
query strings, fragments, and authored request overrides cannot opt into it.
