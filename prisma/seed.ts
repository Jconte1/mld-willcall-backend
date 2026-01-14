import "dotenv/config";
import { PrismaClient, StaffRole } from "@prisma/client";
import { hashPassword } from "../src/lib/passwords";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const name = process.env.INITIAL_ADMIN_NAME ?? "Admin";
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (!email || !password) {
    console.log("Seed skipped: INITIAL_ADMIN_EMAIL and/or INITIAL_ADMIN_PASSWORD not set.");
    return;
  }

  if (!email.toLowerCase().endsWith("@mld.com")) {
    throw new Error("INITIAL_ADMIN_EMAIL must end with @mld.com");
  }

  const existing = await prisma.staffUser.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    console.log("Initial admin already exists:", existing.email);
    return;
  }

  const passwordHash = await hashPassword(password);

  await prisma.staffUser.create({
    data: {
      email: email.toLowerCase(),
      name,
      passwordHash,
      role: StaffRole.ADMIN,
      locationAccess: ["slc-hq", "slc-outlet", "boise-willcall"],
      isActive: true,
      mustChangePassword: false
    }
  });

  console.log("Created initial admin:", email);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
