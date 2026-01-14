"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeReminderTimes = computeReminderTimes;
const businessDay_1 = require("../rules/businessDay");
const eligibility_1 = require("../rules/eligibility");
function computeReminderTimes(startAt, now = new Date()) {
    const diffMs = startAt.getTime() - now.getTime();
    const oneHourAt = new Date(startAt.getTime() - 60 * 60 * 1000);
    const oneDayAt = (0, businessDay_1.previousBusinessDayAtNine)(startAt);
    const within24Hours = diffMs <= 24 * 60 * 60 * 1000;
    const within60Minutes = diffMs <= 60 * 60 * 1000;
    const oneDayEligible = !within24Hours && oneDayAt.getTime() > now.getTime() && !(0, eligibility_1.shouldSkipForQuietHours)(oneDayAt);
    const oneHourEligible = oneHourAt.getTime() > now.getTime() && !(0, eligibility_1.shouldSkipForQuietHours)(oneHourAt);
    const sendOneHourImmediately = within60Minutes && !(0, eligibility_1.shouldSkipForQuietHours)(now);
    return {
        oneDayAt: oneDayEligible ? oneDayAt : null,
        oneHourAt: oneHourEligible ? oneHourAt : null,
        sendOneHourImmediately,
    };
}
