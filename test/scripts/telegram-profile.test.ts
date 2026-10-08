import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { applyProfile, checkProfile, resolveProfile } from "../../scripts/telegram-profile.mjs";
import { shouldAckReaction } from "../../src/channels/ack-reactions.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const profiles = JSON.parse(
  fs.readFileSync(new URL("../../config/telegram-profiles.json", import.meta.url), "utf8"),
).profiles;
const profile = resolveProfile("default", profiles);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cliPath = fileURLToPath(new URL("../../scripts/telegram-profile.mjs", import.meta.url));
const config = () => ({
  agents: { defaults: { model: { primary: "fixture/model" } } },
  messages: { ackReactionScope: "group-all" },
  channels: {
    telegram: {
      accounts: {
        bot: {
          ackReaction: "",
          richMessages: false,
          botToken: { source: "env", id: "FIXTURE_TOKEN" },
          dmPolicy: "allowlist",
          allowFrom: ["fixture-admitted-user"],
          groups: { fixture: { requireMention: false } },
          streaming: { mode: "progress", progress: { label: "fixture-label" } },
        },
        other: { botToken: "fixture-other", streaming: { mode: "off" } },
      },
    },
  },
  bindings: [{ agentId: "fixture", match: { channel: "telegram", accountId: "bot" } }],
  tools: { allow: ["fixture-tool"], deny: ["fixture-denied"] },
  mcp: {
    servers: { fixture: { url: "https://example.invalid/mcp", transport: "streamable-http" } },
  },
});

test("default repairs quiet acknowledgement and preserves credentials, routes, model and MCP", () => {
  const original = config();
  const result = applyProfile(original, "bot", profile);
  assert.equal(result.channels.telegram.accounts.bot.ackReaction, "👀");
  assert.equal(result.channels.telegram.accounts.bot.richMessages, true);
  assert.equal(result.channels.telegram.accounts.bot.streaming.mode, "partial");
  assert.equal(result.agents.defaults.silentReply.group, "allow");
  assert.equal(result.messages.ackReactionScope, "all");
  assert.equal(original.messages.ackReactionScope, "group-all");
  assert.deepEqual(
    result.channels.telegram.accounts.bot.botToken,
    original.channels.telegram.accounts.bot.botToken,
  );
  assert.deepEqual(
    result.channels.telegram.accounts.bot.groups,
    original.channels.telegram.accounts.bot.groups,
  );
  assert.equal(
    result.channels.telegram.accounts.bot.dmPolicy,
    original.channels.telegram.accounts.bot.dmPolicy,
  );
  assert.deepEqual(
    result.channels.telegram.accounts.bot.allowFrom,
    original.channels.telegram.accounts.bot.allowFrom,
  );
  assert.deepEqual(
    result.channels.telegram.accounts.other,
    original.channels.telegram.accounts.other,
  );
  assert.deepEqual(result.bindings, original.bindings);
  assert.deepEqual(result.tools, original.tools);
  assert.deepEqual(result.mcp, original.mcp);
  assert.deepEqual(result.agents.defaults.model, original.agents.defaults.model);
  assert.equal(original.channels.telegram.accounts.bot.ackReaction, "");
  assert.deepEqual(checkProfile(result, "bot", profile), []);
});

test("inherited progress profile retains receipt and rich messages", () => {
  const progress = resolveProfile("operator-progress", profiles);
  assert.equal(progress.telegram_account.streaming.mode, "progress");
  assert.equal(progress.telegram_account.streaming.progress.commentary, true);
  assert.equal(progress.telegram_account.ackReaction, "👀");
  assert.equal(progress.telegram_account.richMessages, true);
});

test("unknown accounts, profiles and cyclic inheritance fail closed", () => {
  assert.throws(() => applyProfile(config(), "unregistered", profile));
  assert.throws(() => resolveProfile("missing", profiles));
  assert.throws(() => resolveProfile("a", { a: { extends: "b" }, b: { extends: "a" } }));
  assert.throws(() => resolveProfile("a", JSON.parse('{"a":{"__proto__":{"polluted":true}}}')));
});

test("CLI check rejects drift, render is idempotent and never prints config values", () => {
  const dir = tempDirs.make("telegram-profile-");
  const filename = path.join(dir, "config.json");
  fs.writeFileSync(filename, JSON.stringify(config()));
  const run = (action: "render" | "check") =>
    spawnSync(process.execPath, [cliPath, action, filename, "bot"], { encoding: "utf8" });
  assert.equal(run("check").status, 1);
  // A pre-existing sibling must survive exclusive-create failure.
  const preload = `import fs from 'node:fs'; fs.writeFileSync(process.argv[3] + '.telegram-profile-' + process.pid, 'fixture-existing');`;
  const collision = spawnSync(
    process.execPath,
    [
      "--import",
      "data:text/javascript," + encodeURIComponent(preload),
      cliPath,
      "render",
      filename,
      "bot",
    ],
    { encoding: "utf8" },
  );
  assert.equal(collision.status, 1);
  const sibling = fs
    .readdirSync(dir)
    .find((name) => name.startsWith("config.json.telegram-profile-"));
  assert.ok(sibling);
  assert.equal(fs.readFileSync(path.join(dir, sibling), "utf8"), "fixture-existing");
  fs.unlinkSync(path.join(dir, sibling));
  assert.equal(run("render").status, 0);
  assert.equal(run("check").status, 0);
  const before = fs.readFileSync(filename, "utf8");
  const beforeStat = fs.statSync(filename);
  const again = run("render");
  assert.equal(again.status, 0);
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  assert.equal(fs.statSync(filename).ino, beforeStat.ino);
  assert.equal(fs.statSync(filename).mtimeMs, beforeStat.mtimeMs);
  assert.equal(again.stdout.includes("FIXTURE_TOKEN"), false);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  const alias = path.join(dir, "alias.json");
  fs.symlinkSync(filename, alias);
  const rejected = spawnSync(process.execPath, [cliPath, "render", alias, "bot"], {
    encoding: "utf8",
  });
  assert.equal(rejected.status, 1);
  assert.equal(fs.lstatSync(alias).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  fs.unlinkSync(alias);
  fs.writeFileSync(filename, "{malformed FIXTURE_TOKEN");
  const malformed = run("render");
  assert.equal(malformed.status, 1);
  assert.equal((malformed.stdout + malformed.stderr).includes("FIXTURE_TOKEN"), false);
  assert.equal(fs.readFileSync(filename, "utf8"), "{malformed FIXTURE_TOKEN");
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
});

test("presentation boundary rejects authority fields and malformed instance containers", () => {
  for (const overlay of [
    {},
    { telegram_account: { ackReaction: "👀" } },
    { ...profile, telegram_account: { ...profile.telegram_account, botToken: "fixture-secret" } },
    { ...profile, agent_defaults: { ...profile.agent_defaults, model: "fixture-model" } },
    { ...profile, messages: { ackReactionScope: ["all"] } },
  ]) {
    assert.throws(() => applyProfile(config(), "bot", overlay));
  }
  for (const container of [null, "fixture", []]) {
    assert.throws(() => applyProfile({ ...config(), messages: container }, "bot", profile));
    const malformedAccount = { channels: { telegram: { accounts: { bot: container } } } };
    assert.throws(() => applyProfile(malformedAccount, "bot", profile));
  }
});

test("switching inherited variants is idempotent and preserves other accounts and streaming tuning", () => {
  const original = config();
  const progress = resolveProfile("operator-progress", profiles);
  const rendered = applyProfile(applyProfile(original, "bot", profile), "bot", progress);
  assert.deepEqual(checkProfile(rendered, "bot", progress), []);
  assert.deepEqual(
    rendered.channels.telegram.accounts.other,
    original.channels.telegram.accounts.other,
  );
  assert.equal(rendered.channels.telegram.accounts.bot.streaming.progress.label, "fixture-label");
  const reverted = applyProfile(rendered, "bot", profile);
  assert.deepEqual(checkProfile(reverted, "bot", profile), []);
  assert.deepEqual(applyProfile(reverted, "bot", profile), reverted);
});

test("CLI refuses a concurrent input change before rename and preserves the external write", () => {
  const dir = tempDirs.make("telegram-profile-concurrent-");
  const filename = path.join(dir, "config.json");
  fs.writeFileSync(filename, JSON.stringify(config()));
  const externalSource = '{"fixtureExternalUpdate":true}\n';
  // First fsync is the completed temp write, before the input comparison and rename.
  const preload = `import fs from 'node:fs';
    const original = fs.fsyncSync;
    let changed = false;
    fs.fsyncSync = (fd) => {
      if (!changed) {
        changed = true;
        fs.writeFileSync(process.argv[3], ${JSON.stringify(externalSource)});
      }
      return original(fd);
    };`;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "data:text/javascript," + encodeURIComponent(preload),
      cliPath,
      "render",
      filename,
      "bot",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(filename, "utf8"), externalSource);
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
  assert.equal((result.stdout + result.stderr).includes("FIXTURE_TOKEN"), false);
});

test("global all policy acknowledges admitted groups and DMs without changing access or routes", () => {
  const original = config();
  for (const name of ["default", "operator-progress"]) {
    const result = applyProfile(original, "bot", resolveProfile(name, profiles));
    for (const isGroup of [true, false]) {
      assert.equal(
        shouldAckReaction({
          scope: result.messages.ackReactionScope,
          isDirect: !isGroup,
          isGroup,
          isMentionableGroup: isGroup,
          canDetectMention: true,
          effectiveWasMentioned: false,
        }),
        true,
      );
    }
    assert.equal(result.agents.defaults.silentReply.group, "allow");
    assert.deepEqual(result.bindings, original.bindings);
    assert.deepEqual(result.tools, original.tools);
    assert.deepEqual(
      result.channels.telegram.accounts.bot.groups,
      original.channels.telegram.accounts.bot.groups,
    );
    assert.equal(
      result.channels.telegram.accounts.bot.dmPolicy,
      original.channels.telegram.accounts.bot.dmPolicy,
    );
    assert.deepEqual(
      result.channels.telegram.accounts.bot.allowFrom,
      original.channels.telegram.accounts.bot.allowFrom,
    );
    assert.deepEqual(
      result.channels.telegram.accounts.other,
      original.channels.telegram.accounts.other,
    );
  }
});
