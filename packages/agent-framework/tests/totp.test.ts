// Newsletter send S1-a (Fable F-3, R-10): HOTP/TOTP/base32/otpauth known answers. Pure, no environment needed.
import { it, expect } from "vitest";
import { hotp, totp, totpStep, verifyTotp, base32Encode, base32Decode, otpauthUri, groupedSecret, newSeed, TOTP } from "../src/access/totp.js";

const RFC_SECRET = Buffer.from("12345678901234567890", "ascii"); // RFC 4226 Appendix D / RFC 6238 Appendix B (SHA-1)

it("RFC 4226 Appendix D: all ten HOTP values", () => {
  expect(Array.from({ length: 10 }, (_, c) => hotp(RFC_SECRET, c))).toEqual(
    ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"]);
});

it("RFC 6238 Appendix B, SHA-1 rows at eight digits; the six-digit values are their truncations", () => {
  const rows: [number, string][] = [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"],
    [2000000000, "69279037"], [20000000000, "65353130"]];
  for (const [t, v] of rows) {
    expect(totp(RFC_SECRET, t * 1000, 8), String(t)).toBe(v);
    expect(totp(RFC_SECRET, t * 1000), String(t)).toBe(v.slice(2)); // six digits = the same binary modulo 10^6
  }
  expect(totpStep(59_000)).toBe(1);
  expect(totpStep(1111111109_000)).toBe(37037036);
});

it("verifyTotp: T-1, T, T+1 accepted and the MATCHED counter returned; beyond the window, malformed and non-strings refused", () => {
  const now = 1234567890_000, t = totpStep(now);
  for (const d of [-1, 0, 1]) expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, t + d), now), String(d)).toBe(t + d);
  for (const d of [-2, 2]) expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, t + d), now), String(d)).toBeNull();
  for (const bad of ["", "12345", "1234567", "12345a", " 123456", "123456 ", 123456, null, undefined, { code: "123456" }]) expect(verifyTotp(RFC_SECRET, bad, now)).toBeNull();
  // At the epoch start there is no T-1: no negative counter is computed.
  expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, 0), 1_000)).toBe(0);
  // A different secret never matches the RFC code.
  expect(verifyTotp(Buffer.alloc(20, 7), hotp(RFC_SECRET, t), now)).toBeNull();
});

it("hotp refuses out-of-range counters and digit counts", () => {
  for (const [c, d] of [[-1, 6], [2n ** 64n, 6], [0, 5], [0, 9], [0, 6.5]] as [number | bigint, number][]) expect(() => hotp(RFC_SECRET, c, d)).toThrow("totp_arg_invalid");
  expect(hotp(RFC_SECRET, 2n ** 64n - 1n)).toMatch(/^[0-9]{6}$/);
});

it("base32 (RFC 4648 §10 vectors, unpadded), odd lengths, case and padding on input, refusals", () => {
  const v: [string, string][] = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
  for (const [plain, enc] of v) { expect(base32Encode(Buffer.from(plain))).toBe(enc); expect(base32Decode(enc).toString()).toBe(plain); }
  expect(base32Encode(RFC_SECRET)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  expect(base32Decode("mzxw6ytboi").toString()).toBe("foobar");
  expect(base32Decode("MZXW6YQ=").toString()).toBe("foob");
  for (let n = 0; n < 40; n++) { const b = newSeed().subarray(0, n % 21); expect(base32Decode(base32Encode(b)).equals(b), String(n)).toBe(true); }
  for (const bad of ["MZXW1", "MZX W6", "M", "MZX", "MZXW6Y", "MZ!W"]) expect(() => base32Decode(bad), bad).toThrow("totp_base32_invalid");
});

it("otpauth URI: issuer and account percent-encoded (colon, space), SHA1 / 6 digits / 30 s, secret in base32", () => {
  const uri = otpauthUri({ issuer: "Kapelle: Example Park", account: "alex p@example.org", secret: RFC_SECRET });
  expect(uri).toBe("otpauth://totp/Kapelle%3A%20Example%20Park:alex%20p%40example.org?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ" +
    "&issuer=Kapelle%3A%20Example%20Park&algorithm=SHA1&digits=6&period=30");
  expect(groupedSecret(RFC_SECRET)).toBe("GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ");
  expect(newSeed()).toHaveLength(TOTP.seedBytes);
  expect(newSeed().equals(newSeed())).toBe(false);
});
