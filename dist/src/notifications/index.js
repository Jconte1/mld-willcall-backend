"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notifyCustomerScheduled = notifyCustomerScheduled;
exports.notifyStaffScheduled = notifyStaffScheduled;
exports.notifyCustomerCancelled = notifyCustomerCancelled;
exports.cancelAppointmentSilently = cancelAppointmentSilently;
exports.notifyStaffCancelled = notifyStaffCancelled;
exports.notifyAppointmentRescheduled = notifyAppointmentRescheduled;
exports.notifyAppointmentCompleted = notifyAppointmentCompleted;
exports.notifyOrderListChanged = notifyOrderListChanged;
exports.notifyAppointmentReady = notifyAppointmentReady;
exports.cancelAppointmentNotifications = cancelAppointmentNotifications;
const appointmentScheduled_1 = require("./scheduler/appointmentScheduled");
const appointmentCancelled_1 = require("./scheduler/appointmentCancelled");
const appointmentRescheduled_1 = require("./scheduler/appointmentRescheduled");
const appointmentCompleted_1 = require("./scheduler/appointmentCompleted");
const appointmentOrderListChanged_1 = require("./scheduler/appointmentOrderListChanged");
const appointmentReady_1 = require("./scheduler/appointmentReady");
const cancelJobs_1 = require("./scheduler/cancelJobs");
async function notifyCustomerScheduled(prisma, appointment, orderNbrs) {
    return (0, appointmentScheduled_1.handleAppointmentScheduled)(prisma, { appointment, orderNbrs, staffCreated: false });
}
async function notifyStaffScheduled(prisma, appointment, orderNbrs) {
    return (0, appointmentScheduled_1.handleAppointmentScheduled)(prisma, {
        appointment,
        orderNbrs,
        staffCreated: true,
        ignoreCap: true,
    });
}
async function notifyCustomerCancelled(prisma, appointment, orderNbrs) {
    return (0, appointmentCancelled_1.handleAppointmentCancelled)(prisma, {
        appointment,
        orderNbrs,
        shouldNotify: true,
    });
}
async function cancelAppointmentSilently(prisma, appointment, orderNbrs) {
    return (0, appointmentCancelled_1.handleAppointmentCancelled)(prisma, {
        appointment,
        orderNbrs,
        shouldNotify: false,
    });
}
async function notifyStaffCancelled(prisma, appointment, orderNbrs, cancelReason, notifyCustomer) {
    const shouldNotify = Boolean(notifyCustomer && cancelReason);
    return (0, appointmentCancelled_1.handleAppointmentCancelled)(prisma, {
        appointment,
        orderNbrs,
        cancelReason,
        shouldNotify,
        ignoreCap: true,
        staffInitiated: true,
    });
}
async function notifyAppointmentRescheduled(prisma, appointment, orderNbrs, oldStartAt, oldEndAt, notifyCustomer, ignoreCap = false, staffInitiated = false) {
    if (!notifyCustomer)
        return;
    return (0, appointmentRescheduled_1.handleAppointmentRescheduled)(prisma, {
        appointment,
        orderNbrs,
        oldStartAt,
        oldEndAt,
        ignoreCap,
        staffInitiated,
    });
}
async function notifyAppointmentCompleted(prisma, appointment, orderNbrs, notifyCustomer, ignoreCap = false, staffInitiated = false) {
    if (!notifyCustomer)
        return;
    return (0, appointmentCompleted_1.handleAppointmentCompleted)(prisma, { appointment, orderNbrs, ignoreCap, staffInitiated });
}
async function notifyOrderListChanged(prisma, appointment, orderNbrs, notifyCustomer, ignoreCap = false, staffInitiated = false) {
    if (!notifyCustomer)
        return;
    return (0, appointmentOrderListChanged_1.handleAppointmentOrderListChanged)(prisma, {
        appointment,
        orderNbrs,
        ignoreCap,
        staffInitiated,
    });
}
async function notifyAppointmentReady(prisma, appointment, orderNbrs, notifyCustomer, ignoreCap = false, staffInitiated = false) {
    if (!notifyCustomer)
        return;
    return (0, appointmentReady_1.handleAppointmentReady)(prisma, {
        appointment,
        orderNbrs,
        ignoreCap,
        staffInitiated,
    });
}
async function cancelAppointmentNotifications(prisma, appointmentId) {
    return (0, cancelJobs_1.cancelPendingJobs)(prisma, appointmentId);
}
