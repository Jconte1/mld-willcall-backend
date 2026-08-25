import { PickupAppointmentStatus, PrismaClient } from "@prisma/client";
import { sendEmail } from "../providers/email/sendEmail";
import { buildOrderReadyEscalationEmail } from "../templates/email/buildOrderReadyEscalationEmail";
import { getOrderReadyBusinessDate, hasSuccessfulOrderReadySyncForToday } from "./syncState";

const DENVER_TZ = "America/Denver";
const JOB_NAME = "order-ready-escalation-daily";
const RUN_HOUR = 9;
const RUN_MINUTE = 45;
const RUN_WINDOW_MINUTES = 12 * 60;
const ESCALATION_THRESHOLD = 5;
const ACTIVE_APPOINTMENT_STATUSES: PickupAppointmentStatus[] = [
  PickupAppointmentStatus.Scheduled,
  PickupAppointmentStatus.Confirmed,
  PickupAppointmentStatus.InProgress,
  PickupAppointmentStatus.Ready,
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

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: new Intl.DateTimeFormat("en-US", { timeZone: DENVER_TZ, weekday: "short" }).format(
      date
    ),
  };
}

async function shouldRun(prisma: PrismaClient, now: Date) {
  const existing = await prisma.orderReadyJobState.findUnique({
    where: { name: JOB_NAME },
  });
  const parts = getDenverParts(now);
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  if (parts.hour < RUN_HOUR || (parts.hour === RUN_HOUR && parts.minute < RUN_MINUTE)) {
    return false;
  }
  const minutesSinceStart =
    parts.hour * 60 + parts.minute - (RUN_HOUR * 60 + RUN_MINUTE);
  if (minutesSinceStart > RUN_WINDOW_MINUTES) return false;
  if (!existing?.lastRunAt) return true;
  const last = getDenverParts(existing.lastRunAt);
  return last.date !== parts.date;
}

async function markRun(prisma: PrismaClient, now: Date) {
  await prisma.orderReadyJobState.upsert({
    where: { name: JOB_NAME },
    update: {
      lastRunAt: now,
      businessDate: getOrderReadyBusinessDate(now),
      startedAt: now,
      completedAt: now,
      status: "success",
      errorSummary: null,
    },
    create: {
      name: JOB_NAME,
      lastRunAt: now,
      businessDate: getOrderReadyBusinessDate(now),
      startedAt: now,
      completedAt: now,
      status: "success",
    },
  });
}

async function markSkipped(prisma: PrismaClient, now: Date, reason: string) {
  await prisma.orderReadyJobState.upsert({
    where: { name: JOB_NAME },
    update: {
      businessDate: getOrderReadyBusinessDate(now),
      startedAt: now,
      completedAt: now,
      status: "skipped",
      errorSummary: reason,
    },
    create: {
      name: JOB_NAME,
      businessDate: getOrderReadyBusinessDate(now),
      startedAt: now,
      completedAt: now,
      status: "skipped",
      errorSummary: reason,
    },
  });
}

export async function runOrderReadyEscalations(prisma: PrismaClient) {
  const now = new Date();
  if (!(await shouldRun(prisma, now))) return;

  const freshness = await hasSuccessfulOrderReadySyncForToday(prisma, now);
  if (!freshness.ok) {
    const reason = "missing-successful-order-ready-sync-for-denver-business-date";
    console.error("[order-ready][escalation] skipped (stale sync state)", {
      reason,
      requiredBusinessDate: freshness.businessDate,
      state: freshness.state,
    });
    await markSkipped(prisma, now, reason);
    return;
  }

  const candidates = await prisma.orderReadyNotice.findMany({
    where: {
      notifyAttemptCount: { gt: ESCALATION_THRESHOLD },
      status: { not: "NotReady" },
    },
    select: {
      id: true,
      orderNbr: true,
      baid: true,
      customerId: true,
      customerIdDescription: true,
      salspersonnumber: true,
      contactName: true,
      contactEmail: true,
      contactPhone: true,
      locationId: true,
      status: true,
      smsOptIn: true,
      emailOptIn: true,
      smsOptOutAt: true,
      smsOptOutReason: true,
      notifyAttemptCount: true,
      lastNotifiedAt: true,
      scheduledAppointmentId: true,
      escalationCount: true,
    },
  });

  console.log("[order-ready][escalation] candidates", { count: candidates.length });
  let resetByAppointment = 0;
  let skippedNoRecipient = 0;
  let sentCount = 0;
  let fallbackRecipientCount = 0;
  let failedCount = 0;

  for (const notice of candidates) {
    try {
      const scheduled = await prisma.pickupAppointmentOrder.findFirst({
        where: {
          orderNbr: notice.orderNbr,
          appointment: { status: { in: ACTIVE_APPOINTMENT_STATUSES } },
        },
        select: { appointmentId: true },
      });

      if (scheduled?.appointmentId) {
        await prisma.orderReadyNotice.update({
          where: { id: notice.id },
          data: {
            scheduledAppointmentId: scheduled.appointmentId,
            notifyAttemptCount: 0,
            lastNotifyAttemptOn: null,
            escalationCount: 0,
            lastEscalatedAt: null,
          },
        });
        resetByAppointment += 1;
        console.log("[order-ready][escalation] reset due to active appointment", {
          orderNbr: notice.orderNbr,
          appointmentId: scheduled.appointmentId,
        });
        continue;
      }

      const summary =
        notice.baid
          ? await prisma.erpOrderSummary.findUnique({
              where: { baid_orderNbr: { baid: notice.baid, orderNbr: notice.orderNbr } },
              select: { salesPersonNumber: true, customerName: true },
            })
          : await prisma.erpOrderSummary.findFirst({
              where: { orderNbr: notice.orderNbr, isActive: true },
              select: { salesPersonNumber: true, customerName: true },
              orderBy: { updatedAt: "desc" },
            });

      const resolvedSalespersonNumber =
        String(notice.salspersonnumber || "").trim() ||
        String(summary?.salesPersonNumber || "").trim() ||
        null;

      const salesperson = resolvedSalespersonNumber
        ? await prisma.staffUser.findFirst({
            where: {
              salespersonNumber: resolvedSalespersonNumber,
              isActive: true,
            },
            select: { email: true, salespersonName: true },
          })
        : null;

      const fallback = (process.env.NOTIFICATIONS_TEST_EMAIL || "").trim();
      const to = (salesperson?.email || "").trim() || fallback;
      const usedFallback = !salesperson?.email;

      if (!to) {
        skippedNoRecipient += 1;
        console.error("[order-ready][escalation] skipped (no recipient)", {
          orderNbr: notice.orderNbr,
          salspersonnumber: notice.salspersonnumber ?? null,
          resolvedSalespersonNumber,
        });
        continue;
      }

      const message = buildOrderReadyEscalationEmail({
        orderNbr: notice.orderNbr,
        customerId: notice.customerId ?? notice.baid ?? null,
        customerName: notice.customerIdDescription ?? summary?.customerName ?? null,
        contactName: notice.contactName ?? null,
        contactEmail: notice.contactEmail ?? null,
        contactPhone: notice.contactPhone ?? null,
        locationId: notice.locationId ?? null,
        status: notice.status ?? null,
        smsOptIn: notice.smsOptIn,
        emailOptIn: notice.emailOptIn,
        smsOptOutAt: notice.smsOptOutAt,
        smsOptOutReason: notice.smsOptOutReason ?? null,
        notifyAttemptCount: notice.notifyAttemptCount,
        lastNotifiedAt: notice.lastNotifiedAt ?? null,
      });

      await sendEmail(to, message.subject, message.body, { allowTestOverride: false });

      await prisma.orderReadyNotice.update({
        where: { id: notice.id },
        data: {
          lastEscalatedAt: now,
          escalationCount: { increment: 1 },
        },
      });

      sentCount += 1;
      if (usedFallback) fallbackRecipientCount += 1;
      console.log("[order-ready][escalation] sent", {
        orderNbr: notice.orderNbr,
        to,
        usedFallback,
        salesperson: salesperson?.salespersonName ?? null,
        salspersonnumber: notice.salspersonnumber ?? null,
        resolvedSalespersonNumber,
        notifyAttemptCount: notice.notifyAttemptCount,
      });
    } catch (error) {
      failedCount += 1;
      console.error("[order-ready][escalation] failed", {
        orderNbr: notice.orderNbr,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
  }

  console.log("[order-ready][escalation] summary", {
    candidates: candidates.length,
    sent: sentCount,
    resetByAppointment,
    skippedNoRecipient,
    fallbackRecipientCount,
    failed: failedCount,
  });

  await markRun(prisma, now);
}
