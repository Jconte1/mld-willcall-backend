import { PrismaClient, PickupAppointmentStatus } from "@prisma/client";
import { fetchOrderReadyReport, OrderReadyRow } from "../../lib/acumatica/fetch/fetchOrderReadyReport";
import { normalizeWarehouseToLocationId } from "../../lib/locationIds";
import { buildOrderReadyLink } from "../links/buildLink";
import { createOrderReadyToken, getActiveOrderReadyToken } from "../links/tokens";
import { sendEmail } from "../providers/email/sendEmail";
import { sendSms } from "../providers/sms/sendSms";
import { buildOrderReadyEmail } from "../templates/email/buildOrderReadyEmail";
import { nextAllowedTime } from "../rules/quietHours";
import { applySmsCompliance } from "../templates/sms/buildSms";

const DENVER_TZ = "America/Denver";
const JOB_NAME = "order-ready-daily";
const RESEND_DAYS = 1;
const MAX_SEND_PER_RUN = 3; // TODO: Remove send restriction for live production.
const RUN_HOUR = 9;
const RUN_MINUTE = 30;
const RUN_WINDOW_MINUTES = 12 * 60;
const ACTIVE_APPOINTMENT_STATUSES: PickupAppointmentStatus[] = [
  PickupAppointmentStatus.Scheduled,
  PickupAppointmentStatus.Confirmed,
  PickupAppointmentStatus.InProgress,
  PickupAppointmentStatus.Ready,
];

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
}

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

function addDays(date: Date, days: number) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
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
    update: { lastRunAt: now },
    create: { name: JOB_NAME, lastRunAt: now },
  });
}

export async function runOrderReadySync(prisma: PrismaClient) {
  const now = new Date();
  if (!(await shouldRun(prisma, now))) return;

  console.log("[order-ready] running daily sync");
  const rows = await fetchOrderReadyReport();
  console.log("[order-ready] rows fetched", { count: rows.length });
  if (rows.length) {
    console.log("[order-ready] sample row", {
      orderNbr: rows[0]?.orderNbr,
      orderType: rows[0]?.orderType,
      status: rows[0]?.status,
      textNotification: rows[0]?.attributeSmsTxt,
      emailNotification: rows[0]?.attributeEmailNoty,
      warehouse: rows[0]?.warehouse,
    });
  }

  const grouped = groupOrderReadyRows(rows);
  const seenOrderNbrs = new Set<string>(Array.from(grouped.keys()));
  let sentCount = 0;
  for (const [orderNbr, bucket] of grouped.entries()) {
    const row = bucket.row;
    const contactEmail = (row.attributeEmailNoty || "").trim() || null;
    const contactPhone = normalizePhone(row.attributeSmsTxt);
    const mappedLocationId = normalizeWarehouseToLocationId(row.warehouse);
    const locationId = mappedLocationId ?? "slc-hq";

    const smsOptIn = Boolean(contactPhone);
    const existingNotice = await prisma.orderReadyNotice.findUnique({
      where: { orderNbr },
      select: {
        id: true,
        attributeSmsTxt: true,
        attributeEmailNoty: true,
        lastNotifiedAt: true,
        nextEligibleNotifyAt: true,
        scheduledAppointmentId: true,
      },
    });

    const prevEmail = (existingNotice?.attributeEmailNoty || "").trim() || null;
    const prevPhone = normalizePhone(existingNotice?.attributeSmsTxt);
    const contactChanged =
      Boolean(existingNotice) && (prevEmail !== contactEmail || prevPhone !== contactPhone);
    const nextEligibleOverride =
      contactChanged && existingNotice?.lastNotifiedAt ? now : undefined;

    const updateData = {
      baid: row.customerId ?? null,
      status: row.status ?? null,
      orderType: row.orderType ?? null,
      shipVia: row.shipVia ?? null,
      qtyUnallocated: row.qtyUnallocated ?? null,
      qtyAllocated: row.qtyAllocated ?? null,
      customerId: row.customerId ?? null,
      customerLocationId: row.customerLocationId ?? null,
      attributeBuyerGroup: row.attributeBuyerGroup ?? null,
      attributeOsContact: row.attributeOsContact ?? null,
      attributeSiteNumber: row.attributeSiteNumber ?? null,
      attributeDelEmail: row.attributeDelEmail ?? null,
      attributeSmsTxt: row.attributeSmsTxt ?? null,
      attributeEmailNoty: row.attributeEmailNoty ?? null,
      contactName: row.attributeSiteNumber ?? null, // TODO: replace with actual contact name field
      contactPhone, // TODO: replace with actual contact phone field
      contactEmail,
      locationId,
      smsOptIn,
      lastReadyAt: now,
      ...(nextEligibleOverride ? { nextEligibleNotifyAt: nextEligibleOverride } : {}),
    };

    const createData = {
      orderNbr,
      baid: row.customerId ?? null,
      status: row.status ?? null,
      orderType: row.orderType ?? null,
      shipVia: row.shipVia ?? null,
      qtyUnallocated: row.qtyUnallocated ?? null,
      qtyAllocated: row.qtyAllocated ?? null,
      customerId: row.customerId ?? null,
      customerLocationId: row.customerLocationId ?? null,
      attributeBuyerGroup: row.attributeBuyerGroup ?? null,
      attributeOsContact: row.attributeOsContact ?? null,
      attributeSiteNumber: row.attributeSiteNumber ?? null,
      attributeDelEmail: row.attributeDelEmail ?? null,
      attributeSmsTxt: row.attributeSmsTxt ?? null,
      attributeEmailNoty: row.attributeEmailNoty ?? null,
      contactName: row.attributeSiteNumber ?? null, // TODO: replace with actual contact name field
      contactPhone, // TODO: replace with actual contact phone field
      contactEmail,
      locationId,
      smsOptIn,
      lastReadyAt: now,
    };

    const notice = await prisma.orderReadyNotice.upsert({
      where: { orderNbr },
      update: updateData,
      create: createData,
    });

    await prisma.orderReadyLine.deleteMany({ where: { orderReadyId: notice.id } });
    if (bucket.inventoryIds.size) {
      await prisma.orderReadyLine.createMany({
        data: Array.from(bucket.inventoryIds).map((inventoryId) => ({
          orderReadyId: notice.id,
          orderNbr,
          inventoryId,
        })),
        skipDuplicates: true,
      });
    }

    const normalizedStatus = (notice.status || "").toLowerCase();
    if (normalizedStatus === "scheduled" || normalizedStatus === "completed") {
      continue;
    }

    const scheduledAppointment = await prisma.pickupAppointmentOrder.findFirst({
      where: {
        orderNbr,
        appointment: {
          status: { in: ACTIVE_APPOINTMENT_STATUSES },
        },
      },
      include: { appointment: true },
      orderBy: { appointment: { startAt: "desc" } },
    });

    if (scheduledAppointment?.appointmentId) {
      await prisma.orderReadyNotice.update({
        where: { id: notice.id },
        data: { scheduledAppointmentId: scheduledAppointment.appointmentId },
      });
      continue;
    }

    if (notice.scheduledAppointmentId) {
      await prisma.orderReadyNotice.update({
        where: { id: notice.id },
        data: { scheduledAppointmentId: null },
      });
    }

    const eligible =
      !notice.lastNotifiedAt ||
      (notice.nextEligibleNotifyAt && notice.nextEligibleNotifyAt <= now);
    if (!eligible) continue;

    if (!notice.contactEmail && !process.env.NOTIFICATIONS_TEST_EMAIL) {
      // TODO: When production-ready, require a real contactEmail before sending.
      // TODO: If the email is invalid or bounces, notify the salesperson for this order.
      console.log("[order-ready] skipped (missing email)", { orderNbr });
      continue;
    }

    const activeToken = await getActiveOrderReadyToken(prisma, notice.id);
    const tokenRow = activeToken ?? (await createOrderReadyToken(prisma, notice.id));
    const link = buildOrderReadyLink(orderNbr, tokenRow.token);
    const message = buildOrderReadyEmail(orderNbr, link);
    const recipient = notice.contactEmail || process.env.NOTIFICATIONS_TEST_EMAIL || "";
    if (!recipient) {
      console.log("[order-ready] skipped (missing recipient)", { orderNbr });
      continue;
    }

    if (sentCount >= MAX_SEND_PER_RUN) {
      console.log("[order-ready] email suppressed (limit reached)", { orderNbr });
      continue;
    }

    const sendAt = nextAllowedTime(now);
    if (sendAt.getTime() > now.getTime()) {
      console.log("[order-ready] deferred (quiet hours)", { orderNbr, sendAt: sendAt.toISOString() });
      continue;
    }

    await sendEmail(recipient, message.subject, message.body, { allowTestOverride: false });
    sentCount += 1;

    if (notice.smsOptIn && !notice.smsOptOutAt && notice.contactPhone) {
      // TODO: switch to real opt-in + phone source when available in production.
      const smsBase = `MLD Will Call: Order ${orderNbr} is ready for pickup. Schedule here: ${link}`;
      const includeStopLine = !notice.smsFirstSentAt;
      const smsBody = applySmsCompliance(smsBase, includeStopLine);
      await sendSms(notice.contactPhone, smsBody, { allowTestOverride: false });
      if (!notice.smsFirstSentAt) {
        await prisma.orderReadyNotice.update({
          where: { id: notice.id },
          data: { smsFirstSentAt: new Date() },
        });
      }
    }

    // TODO: After 5 consecutive daily sends, escalate to the salesperson for follow-up.
    await prisma.orderReadyNotice.update({
      where: { id: notice.id },
      data: {
        lastNotifiedAt: now,
        nextEligibleNotifyAt: addDays(now, RESEND_DAYS),
      },
    });

    console.log("[order-ready] notified", { orderNbr });
  }

  const staleNotices = await prisma.orderReadyNotice.findMany({
    where: { orderNbr: { notIn: Array.from(seenOrderNbrs) } },
    select: { id: true, orderNbr: true },
  });

  if (staleNotices.length) {
    await prisma.orderReadyNotice.updateMany({
      where: { id: { in: staleNotices.map((notice) => notice.id) } },
      data: {
        status: "NotReady",
        nextEligibleNotifyAt: null,
      },
    });

    await prisma.orderReadyLine.deleteMany({
      where: { orderReadyId: { in: staleNotices.map((notice) => notice.id) } },
    });

    await prisma.orderReadyAccessToken.updateMany({
      where: { orderReadyId: { in: staleNotices.map((notice) => notice.id) }, revokedAt: null },
      data: { revokedAt: now },
    });

    console.log("[order-ready] marked not-ready", { count: staleNotices.length });
  }

  await markRun(prisma, now);
}

function groupOrderReadyRows(rows: OrderReadyRow[]) {
  const grouped = new Map<string, { row: OrderReadyRow; inventoryIds: Set<string> }>();

  for (const row of rows) {
    if (!row.orderNbr) continue;
    const orderNbr = row.orderNbr.trim();
    if (!orderNbr) continue;
    const existing = grouped.get(orderNbr);
    const inventoryId = row.inventoryId ? String(row.inventoryId).trim() : "";
    if (existing) {
      if (inventoryId) existing.inventoryIds.add(inventoryId);
    } else {
      grouped.set(orderNbr, {
        row,
        inventoryIds: inventoryId ? new Set([inventoryId]) : new Set(),
      });
    }
  }

  return grouped;
}
