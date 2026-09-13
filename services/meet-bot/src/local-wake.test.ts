import assert from 'node:assert/strict';
import { LocalWakeDetector } from './local-wake';

async function main(): Promise<void> {
  let wakes = 0;
  const errors: Error[] = [];
  const mock = [
    "process.stdout.write(JSON.stringify({type:'ready'})+'\\n')",
    "process.stdin.once('data',()=>process.stdout.write(JSON.stringify({type:'wake'})+'\\n'))",
    'setInterval(()=>{},1000)',
  ].join(';');
  const detector = new LocalWakeDetector({
    pythonPath: process.execPath,
    scriptPath: '-e',
    modelPath: mock,
    onWake: () => {
      wakes += 1;
    },
    onError: (error) => errors.push(error),
  });
  await detector.start();
  detector.push(Buffer.from([1, 2, 3, 4]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(wakes, 1);
  await detector.stop();
  assert.deepEqual(errors, []);

  const startupErrors: Error[] = [];
  const failed = new LocalWakeDetector({
    pythonPath: process.execPath,
    scriptPath: '-e',
    modelPath: "process.stderr.write('model incompatible');process.exit(1)",
    onWake: () => {},
    onError: (error) => startupErrors.push(error),
  });
  await assert.rejects(failed.start(), /model incompatible/);
  assert.equal(startupErrors.length, 1);
  console.log('local-wake tests passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
