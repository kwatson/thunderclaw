#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SIGNOFF_PATTERN = /^Signed-off-by:\s*(.+?)\s*<([^<>]+)>\s*$/i;

export function validAuthorSignoff(authorEmail, trailers) {
  return trailers.some((trailer) => {
    const match = SIGNOFF_PATTERN.exec(trailer);
    return match?.[2].trim().toLowerCase() === authorEmail.trim().toLowerCase();
  });
}

function git(args, options = {}) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    ...options,
  });

  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message || result.stderr?.trim() || result.stdout?.trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }

  return result.stdout;
}

function trailersFor(message) {
  return git(["interpret-trailers", "--parse"], { input: message })
    .split("\n")
    .filter(Boolean);
}

function isBot(authorName, authorEmail) {
  return (
    authorName.endsWith("[bot]") ||
    authorEmail.toLowerCase().endsWith("[bot]@users.noreply.github.com")
  );
}

export function checkRange(base, head) {
  const commits = git(["rev-list", "--no-merges", `${base}..${head}`])
    .split("\n")
    .filter(Boolean);
  const failures = [];

  for (const commit of commits) {
    const metadata = git([
      "show",
      "--no-patch",
      "--format=%an%x00%ae%x00%B",
      commit,
    ]);
    const [authorName, authorEmail, message = ""] = metadata.split("\0", 3);

    if (
      !isBot(authorName, authorEmail) &&
      !validAuthorSignoff(authorEmail, trailersFor(message))
    ) {
      failures.push({ commit, authorName, authorEmail });
    }
  }

  return failures;
}

function main() {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("Usage: node scripts/check-dco.mjs <base> <head>");
    process.exitCode = 2;
    return;
  }

  const failures = checkRange(base, head);
  if (failures.length === 0) {
    console.log("All pull-request commits have valid DCO signoffs.");
    return;
  }

  console.error("The following commits are missing a valid author signoff:");
  for (const { commit, authorName, authorEmail } of failures) {
    console.error(`- ${commit.slice(0, 12)} (${authorName} <${authorEmail}>)`);
  }
  console.error(
    "Add a matching Signed-off-by trailer with git commit --amend --signoff " +
      "or an interactive rebase, then push the rewritten commits.",
  );
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
