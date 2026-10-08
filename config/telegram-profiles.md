# Portable Telegram presentation profiles

`telegram-profiles.json` is the shared, credential-free source for new Telegram
accounts. `default` enables receipt acknowledgement (`👀`) in admitted groups and direct messages, rich messages,
partial answer previews and optional replies in groups. `operator-progress`
inherits it and selects the progress draft with tool rows and commentary.

Profiles are opt-in deployment templates. They contain no tokens, identities,
groups, tool grants, MCP endpoints or model choices. Account registration and
access policy remain with the deployment owner.

Render and check an offline JSON deployment configuration:

```sh
node scripts/telegram-profile.mjs render config.json my-account
node scripts/telegram-profile.mjs check config.json my-account
node scripts/telegram-profile.mjs render config.json my-account operator-progress
```

The selected account must already exist. Rendering applies its presentation
fields and the profile's installation-wide settings, merges inherited settings,
preserves unrelated configuration and uses
an atomic replacement with a compare-before-write guard. Checks return a
nonzero exit status for drift. Output contains field paths and metadata only.
Repeated rendering of a matching configuration does not write the file.
The renderer accepts regular JSON files and existing object-valued accounts.
Malformed containers and profile fields outside the presentation boundary fail
without changing the input. Symlinks are rejected. Prepare inputs in a private
working directory with a single writer: the comparison detects changes observed
before replacement and does not provide a lock against concurrent writers.
Replacement sets file permissions to `0600`.

Only leaves declared by the selected profile participate in drift checks.
Switching back to `default` restores partial mode and retains inactive progress
settings and instance-specific streaming tuning. The global acknowledgement scope
is `all`: acknowledgement is enabled in groups and direct messages that the
existing routes and access policies admit. Rendering replaces an existing global
scope, including `group-all`, `direct` or `off`, with `all`. Other accounts and
channels using this global scope also receive the new policy. Receipt reactions
do not admit new senders or conversations: `dmPolicy`, allowlists, groups, routes,
credentials and grants remain unchanged.

The renderer contracts are tested in the fork's canonical Vitest tooling lane
at `test/scripts/telegram-profile.test.ts`. The native changed-file check selects root-test lint and types; the native test
planner and PR CI select this test through the normal tooling routing.

Deploy OS consumes this versioned catalog
and renderer by pinned fork revision and records the chosen profile; its projection
must not define a second copy of the default.

Use this renderer only for offline deployment inputs. Running Gateways own
their native config validation, lock, reload plan and safe lifecycle. Validate
the resulting config with the installed OpenClaw version before deployment;
apply live changes through that version's managed configuration workflow.
Both `agents.defaults.silentReply.group` and `messages.ackReactionScope` are
installation-wide settings. Every render applies these global profile leaves
alongside presentation settings for the selected Telegram account, without a
separate global-apply flag. Group silence and acknowledgement can therefore
change for other accounts and channels using these defaults. Explicit commands, mentions and direct-message replies remain required.

Acceptance must cover the agent's callable tool catalog and the user-facing
Telegram flow. A healthy service or direct HTTP MCP request alone does not prove
tool availability. Verify the MCP transport and SDK-valid tool schemas, a
read-only tool call, acknowledgement, a formatted final reply and a sufficiently
long partial preview. Record any unobserved live Telegram check as `NOT_RUN`.
