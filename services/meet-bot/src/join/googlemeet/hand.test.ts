import assert from "node:assert/strict";
import { handCurrentlyRaised, looksLikeHandLabel, scoreHandButton } from "./hand";

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    passed++;
  } catch {
    console.log(
      `  \x1b[31mFAIL\x1b[0m  ${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
    failed++;
  }
}

check("English raise means currently down", handCurrentlyRaised("Raise hand", null), false);
check("English lower means currently up", handCurrentlyRaised("Lower hand", null), true);
check("Spanish levantar means currently down", handCurrentlyRaised("Levantar la mano", null), false);
check("Spanish bajar means currently up", handCurrentlyRaised("Bajar la mano", null), true);
check("aria-pressed wins", handCurrentlyRaised("Hand", "true"), true);
check("reactions is not the hand", looksLikeHandLabel("Send a reaction"), false);
check("raise hand label matches", looksLikeHandLabel("Raise hand"), true);
check("Spanish hand label matches", looksLikeHandLabel("Levantar la mano"), true);
check(
  "a huge tile is not the hand button",
  scoreHandButton({
    label: "Raise hand",
    ariaPressed: "false",
    area: 640 * 360,
    yRatio: 0.4,
    tag: "DIV",
  }),
  null,
);
check(
  "toolbar hand button scores",
  (scoreHandButton({
    label: "Raise hand",
    ariaPressed: "false",
    area: 48 * 48,
    yRatio: 0.92,
    tag: "BUTTON",
  }) ?? 0) > 15,
  true,
);

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
