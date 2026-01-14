import bcrypt from "bcryptjs";

export function validatePasswordRules(pw: string): { ok: boolean; message?: string } {
  if (pw.length < 8) return { ok: false, message: "Password must be at least 8 characters." };
  if (!/[0-9]/.test(pw)) return { ok: false, message: "Password must include at least 1 number." };
  if (!/[^A-Za-z0-9]/.test(pw)) return { ok: false, message: "Password must include at least 1 symbol." };
  return { ok: true };
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(pw, salt);
}

export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

export function generateTempPassword(length = 14): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const numbers = "23456789";
  const symbols = "!@#$%^&*";
  const all = alphabet + numbers + symbols;

  // Ensure at least 1 number and 1 symbol
  const pick = (s: string) => s[Math.floor(Math.random() * s.length)];
  const chars: string[] = [pick(numbers), pick(symbols)];
  while (chars.length < length) chars.push(pick(all));

  // Shuffle
  for (let i = chars.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
