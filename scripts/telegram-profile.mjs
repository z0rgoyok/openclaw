#!/usr/bin/env node
// Portable, opt-in Telegram presentation profiles. No credentials or grants.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const profilesPath = new URL("../config/telegram-profiles.json", import.meta.url);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function merge(base, overlay) {
  for (const [key, value] of Object.entries(overlay)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new Error("Unsafe profile key");
    }
    if (object(value) && object(base[key])) {
      merge(base[key], value);
    } else {
      base[key] = structuredClone(value);
    }
  }
  return base;
}

export function resolveProfile(name, profiles, trail = []) {
  if (trail.includes(name)) {
    throw new Error("Profile inheritance cycle");
  }
  if (!Object.hasOwn(profiles, name)) {
    throw new Error("Unknown Telegram profile");
  }
  const profile = structuredClone(profiles[name]);
  const parent = profile.extends;
  delete profile.extends;
  return merge(parent ? resolveProfile(parent, profiles, [...trail, name]) : {}, profile);
}

// The profile owns presentation leaves only; deployment authority stays with the instance.
const ownedLeaves = new Set([
  "agent_defaults.silentReply.group",
  "messages.ackReactionScope",
  "telegram_account.ackReaction",
  "telegram_account.richMessages",
  "telegram_account.streaming.mode",
  "telegram_account.streaming.preview.toolProgress",
  "telegram_account.streaming.preview.commandText",
  "telegram_account.streaming.progress.toolProgress",
  "telegram_account.streaming.progress.commandText",
  "telegram_account.streaming.progress.maxLines",
  "telegram_account.streaming.progress.maxLineChars",
  "telegram_account.streaming.progress.commentary",
]);

function validateProfile(profile, prefix = "") {
  if (!object(profile)) {
    throw new Error("Invalid Telegram profile");
  }
  for (const [key, value] of Object.entries(profile)) {
    const location = prefix ? `${prefix}.${key}` : key;
    if (object(value) && Object.keys(value).length) {
      validateProfile(value, location);
    } else if (
      !ownedLeaves.has(location) ||
      value === undefined ||
      value === null ||
      Array.isArray(value)
    ) {
      throw new Error("Profile contains an unowned field");
    }
  }
}

function expectedConfig(profile, account) {
  if (
    !object(profile) ||
    !["agent_defaults", "messages", "telegram_account"].every((key) => object(profile[key]))
  ) {
    throw new Error("Incomplete Telegram profile");
  }
  validateProfile(profile);
  return {
    agents: { defaults: profile.agent_defaults },
    messages: profile.messages,
    channels: { telegram: { accounts: { [account]: profile.telegram_account } } },
  };
}

function differences(expected, actual, prefix = "") {
  const result = [];
  for (const [key, value] of Object.entries(expected)) {
    const location = prefix ? `${prefix}.${key}` : key;
    if (object(value)) {
      result.push(...differences(value, object(actual[key]) ? actual[key] : {}, location));
    } else if (actual[key] !== value) {
      result.push(location);
    }
  }
  return result;
}

export function applyProfile(config, account, profile) {
  if (
    !object(config) ||
    !Object.hasOwn(config.channels?.telegram?.accounts ?? {}, account) ||
    !object(config.channels.telegram.accounts[account])
  ) {
    throw new Error("Account must already be registered");
  }
  const expected = expectedConfig(profile, account);
  // Reject malformed ancestors instead of replacing instance data with an object.
  function checkObjects(actual, template) {
    for (const [key, value] of Object.entries(template)) {
      if (!object(value)) {
        continue;
      }
      if (Object.hasOwn(actual, key) && !object(actual[key])) {
        throw new Error("Invalid config object");
      }
      checkObjects(actual[key] ?? {}, value);
    }
  }
  checkObjects(config, expected);
  return merge(structuredClone(config), expected);
}

export function checkProfile(config, account, profile) {
  // Validate the same boundary as render, including a missing account.
  applyProfile(config, account, profile);
  return differences(expectedConfig(profile, account), config);
}

function main() {
  const [action, filename, account, name = "default", ...extra] = process.argv.slice(2);
  if (!["render", "check"].includes(action) || !filename || !account || extra.length) {
    throw new Error("Usage: telegram-profile.mjs <render|check> <config.json> <account> [profile]");
  }
  const catalog = JSON.parse(fs.readFileSync(profilesPath, "utf8"));
  if (catalog.schema_version !== 1 || !object(catalog.profiles)) {
    throw new Error("Unsupported profile catalog");
  }
  const profiles = catalog.profiles;
  const profile = resolveProfile(name, profiles);
  if (!fs.lstatSync(filename).isFile()) {
    throw new Error("Config must be a regular file");
  }
  const source = fs.readFileSync(filename, "utf8");
  const config = JSON.parse(source);
  const differingPaths = checkProfile(config, account, profile);
  if (action === "render" && differingPaths.length) {
    const candidate = JSON.stringify(applyProfile(config, account, profile), null, 2) + "\n";
    const temp = `${filename}.telegram-profile-${process.pid}`;
    let ownsTemp = false;
    try {
      const fd = fs.openSync(temp, "wx", 0o600);
      ownsTemp = true;
      try {
        fs.writeFileSync(fd, candidate);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (fs.readFileSync(filename, "utf8") !== source) {
        throw new Error("Config changed; retry");
      }
      fs.renameSync(temp, filename);
      const dir = fs.openSync(path.dirname(path.resolve(filename)), "r");
      try {
        fs.fsyncSync(dir);
      } finally {
        fs.closeSync(dir);
      }
    } finally {
      if (ownsTemp && fs.existsSync(temp)) {
        fs.unlinkSync(temp);
      }
    }
  }
  console.log(
    JSON.stringify({
      action,
      account,
      profile: name,
      differingPaths,
      ok: action === "render" || !differingPaths.length,
    }),
  );
  return Number(action === "check" && differingPaths.length > 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch {
    console.error("Telegram profile operation failed; config values suppressed");
    process.exitCode = 1;
  }
}
