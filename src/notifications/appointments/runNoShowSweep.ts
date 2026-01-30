import { PickupAppointmentStatus, PrismaClient } from "@prisma/client";
import { formatDenverDateTime, formatOrderList } from "../format";
import { sendEmail } from "../providers/email/sendEmail";
import { sendSms } from "../providers/sms/sendSms";
import { cancelPendingJobs } from "../scheduler/cancelJobs";
import { buildNoShowEmail } from "../templates/email/buildNoShowEmail";

const DENVER_TZ = "America/Denver";
const JOB_NAME = "appointment-no-show-sweep";

const ACTIVE_STATUSES: PickupAppointmentStatus[] = [
  PickupAppointmentStatus.Scheduled,
  PickupAppointmentStatus.Confirmed,
  PickupAppointmentStatus.InProgress,
  PickupAppointmentStatus.Ready,
  PickupAppointmentStatus.NoShow,
];

function getDenverParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DENVER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

async function shouldRun(prisma: PrismaClient, now: Date) {
  const parts = getDenverParts(now);
  if (parts.hour < 17 || (parts.hour === 17 && parts.minute < 15)) return false;

  const existing = await prisma.orderReadyJobState.findUnique({
    where: { name: JOB_NAME },
  });
  if (!existing?.lastRunAt) return true;
  const last = getDenverParts(existing.lastRunAt);
  return last.date !== parts.date;
}

async function markRun(prisma: PrismaClient, now: Date) {
  await prisma.orderReadyJobState.upsert({
    where: { name: JOB_NAME },
    update: { lastRunAt: now },
    create: { name: JOB_NAME, lastRunAt: now },
  });
}

async function sendNoShowNotifications(appointment: {
  id: string;
  startAt: Date;
  endAt: Date;
  emailOptIn: boolean;
  emailOptInEmail: string | null;
  customerEmail: string;
  smsOptIn: boolean;
  smsOptInPhone: string | null;
  customerPhone: string | null;
  orders: { orderNbr: string }[];
}) {
  const when = formatDenverDateTime(appointment.startAt);
  const orderList = formatOrderList(appointment.orders.map((o) => o.orderNbr));

  if (appointment.emailOptIn) {
    const recipient = appointment.emailOptInEmail || appointment.customerEmail;
    const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/$/, "");
    const link = frontendUrl ? `${frontendUrl}/` : "https://mld-willcall.vercel.app";
    const message = buildNoShowEmail(when, orderList, link);
    await sendEmail(recipient, message.subject, message.body);
  }

  if (appointment.smsOptIn) {
    const smsTo = appointment.smsOptInPhone || appointment.customerPhone || "";
    if (smsTo) {
      const smsBody = `We missed you at your pickup on ${when}. ${orderList} Your items are being returned to stock. Please reschedule ASAP.`;
      await sendSms(smsTo, smsBody);
    }
  }
}

export async function runNoShowSweep(prisma: PrismaClient) {
  const now = new Date();
  if (!(await shouldRun(prisma, now))) return;

  const appointments = await prisma.pickupAppointment.findMany({
    where: {
      status: { in: ACTIVE_STATUSES },
      endAt: { lt: now },
    },
    include: { orders: true },
  });

  if (!appointments.length) {
    await markRun(prisma, now);
    return;
  }

  for (const appointment of appointments) {
    const updated =
      appointment.status === PickupAppointmentStatus.NoShow
        ? appointment
        : await prisma.pickupAppointment.update({
            where: { id: appointment.id },
            data: { status: PickupAppointmentStatus.NoShow },
          });

    await cancelPendingJobs(prisma, updated.id);
    await sendNoShowNotifications({
      id: updated.id,
      startAt: updated.startAt,
      endAt: updated.endAt,
      emailOptIn: updated.emailOptIn,
      emailOptInEmail: updated.emailOptInEmail,
      customerEmail: updated.customerEmail,
      smsOptIn: updated.smsOptIn,
      smsOptInPhone: updated.smsOptInPhone,
      customerPhone: updated.customerPhone,
      orders: appointment.orders,
    });
  }

  await markRun(prisma, now);
  console.log("[appointments] no-show sweep", { count: appointments.length });
}
