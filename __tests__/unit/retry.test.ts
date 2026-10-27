import { describe, test, expect } from "bun:test";
import { isRetryable, withRetry } from "../../retry";

function failure(code: string) {
  return Object.assign(new Error(code), { code });
}

function failingTimes(times: number, code: string) {
  let calls = 0;
  const fn = async () => {
    calls++;
    if (calls <= times) throw failure(code);
    return "done";
  };
  return { fn, calls: () => calls };
}

describe("isRetryable", () => {
  test("accepts failures that applied nothing", () => {
    for (const code of ["ECONNREFUSED", "CONNECT_TIMEOUT", "57P03", "53300", "40P01"]) {
      expect(isRetryable(failure(code))).toBe(true);
    }
  });

  test("rejects a dropped connection, which may have committed first", () => {
    expect(isRetryable(failure("CONNECTION_CLOSED"))).toBe(false);
    expect(isRetryable(failure("ECONNRESET"))).toBe(false);
  });

  test("rejects errors in the statement itself", () => {
    expect(isRetryable(failure("42703"))).toBe(false);
    expect(isRetryable(failure("23505"))).toBe(false);
    expect(isRetryable(new Error("no code"))).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe("withRetry", () => {
  test("runs again after a retryable failure", async () => {
    const { fn, calls } = failingTimes(2, "ECONNREFUSED");
    expect(await withRetry(fn, [0, 0, 0])).toBe("done");
    expect(calls()).toBe(3);
  });

  test("gives up once the delays run out", async () => {
    const { fn, calls } = failingTimes(5, "ECONNREFUSED");
    await expect(withRetry(fn, [0, 0])).rejects.toMatchObject({ code: "ECONNREFUSED" });
    expect(calls()).toBe(3);
  });

  test("does not run again after a failure that isn't retryable", async () => {
    const { fn, calls } = failingTimes(1, "42703");
    await expect(withRetry(fn, [0, 0])).rejects.toMatchObject({ code: "42703" });
    expect(calls()).toBe(1);
  });
});
