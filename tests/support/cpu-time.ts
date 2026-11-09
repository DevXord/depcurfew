// The time limits of the tests that guard against slow input (quadratic parsing, deep trees, large documents) measure
// the CPU time of the test's own process, not the time on the clock. CI runs every test file in parallel on a runner
// with few cores, where another file can take the CPU for seconds, so a limit of 2 s on the clock failed now and then
// although the code was as fast as ever (doctor on thousands of dependency groups took 2.46 s on Windows). CPU time
// grows only while this process works, so slow code still fails the limit and a busy machine does not. Each test file
// runs in a process of its own (Vitest's default pool, forks), and none of these tests starts another process, whose
// work would not count here.

/** The CPU time this process has used so far, user and system, in milliseconds: use it as performance.now() is used. */
export function cpuNow(): number {
  const { user, system } = process.cpuUsage();
  return (user + system) / 1000;
}
