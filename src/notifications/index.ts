import { PrismaClient } from "@prisma/client";
import { handleAppointmentScheduled } from "./scheduler/appointmentScheduled";
import { handleAppointmentCancelled } from "./scheduler/appointmentCancelled";
import { handleAppointmentRescheduled } from "./scheduler/appointmentRescheduled";
import { handleAppointmentCompleted } from "./scheduler/appointmentCompleted";
import { handleAppointmentOrderListChanged } from "./scheduler/appointmentOrderListChanged";
import { handleAppointmentReady } from "./scheduler/appointmentReady";
import { cancelPendingJobs } from "./scheduler/cancelJobs";
import { AppointmentWithContact } from "./types";

export async function notifyCustomerScheduled(
  prisma: PrismaClient,
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] },
  orderNbrs: string[]
) {
  return handleAppointmentScheduled(prisma, { appointment, orderNbrs, staffCreated: false });
}

export async function notifyStaffScheduled(
  prisma: PrismaClient,
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] },
  orderNbrs: string[]
) {
  return handleAppointmentScheduled(prisma, {
    appointment,
    orderNbrs,
    staffCreated: true,
    ignoreCap: true,
  });
}

export async function notifyCustomerCancelled(
  prisma: PrismaClient,
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] },
  orderNbrs: string[]
) {
  return handleAppointmentCancelled(prisma, {
    appointment,
    orderNbrs,
    shouldNotify: true,
  });
}

export async function cancelAppointmentSilently(
  prisma: PrismaClient,
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] },
  orderNbrs: string[]
) {
  return handleAppointmentCancelled(prisma, {
    appointment,
    orderNbrs,
    shouldNotify: false,
  });
}

export async function notifyStaffCancelled(
  prisma: PrismaClient,
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] },
  orderNbrs: string[],
  cancelReason: string | null,
  notifyCustomer: boolean
) {
  const shouldNotify = Boolean(notifyCustomer && cancelReason);
  return handleAppointmentCancelled(prisma, {
    appointment,
    orderNbrs,
    cancelReason,
    shouldNotify,
    ignoreCap: true,
    staffInitiated: true,
  });
}

export async function notifyAppointmentRescheduled(
  prisma: PrismaClient,
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] },
  orderNbrs: string[],
  oldStartAt: Date,
  oldEndAt: Date,
  notifyCustomer: boolean,
  ignoreCap = false,
  staffInitiated = false
) {
  if (!notifyCustomer) return;
  return handleAppointmentRescheduled(prisma, {
    appointment,
    orderNbrs,
    oldStartAt,
    oldEndAt,
    ignoreCap,
    staffInitiated,
  });
}

export async function notifyAppointmentCompleted(
  prisma: PrismaClient,
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] },
  orderNbrs: string[],
  notifyCustomer: boolean,
  ignoreCap = false,
  staffInitiated = false
) {
  if (!notifyCustomer) return;
  return handleAppointmentCompleted(prisma, { appointment, orderNbrs, ignoreCap, staffInitiated });
}

export async function notifyOrderListChanged(
  prisma: PrismaClient,
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] },
  orderNbrs: string[],
  notifyCustomer: boolean,
  ignoreCap = false,
  staffInitiated = false
) {
  if (!notifyCustomer) return;
  return handleAppointmentOrderListChanged(prisma, {
    appointment,
    orderNbrs,
    ignoreCap,
    staffInitiated,
  });
}

export async function notifyAppointmentReady(
  prisma: PrismaClient,
  appointment: AppointmentWithContact & { orders?: { orderNbr: string }[] },
  orderNbrs: string[],
  notifyCustomer: boolean,
  ignoreCap = false,
  staffInitiated = false
) {
  if (!notifyCustomer) return;
  return handleAppointmentReady(prisma, {
    appointment,
    orderNbrs,
    ignoreCap,
    staffInitiated,
  });
}

export async function cancelAppointmentNotifications(
  prisma: PrismaClient,
  appointmentId: string
) {
  return cancelPendingJobs(prisma, appointmentId);
}
