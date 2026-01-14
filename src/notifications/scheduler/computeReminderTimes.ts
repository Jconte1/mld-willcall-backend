import { previousBusinessDayAtNine } from "../rules/businessDay";
import { shouldSkipForQuietHours } from "../rules/eligibility";

export function computeReminderTimes(startAt: Date, now: Date = new Date()) {
  const diffMs = startAt.getTime() - now.getTime();
  const oneHourAt = new Date(startAt.getTime() - 60 * 60 * 1000);
  const oneDayAt = previousBusinessDayAtNine(startAt);

  const within24Hours = diffMs <= 24 * 60 * 60 * 1000;
  const within60Minutes = diffMs <= 60 * 60 * 1000;

  const oneDayEligible =
    !within24Hours && oneDayAt.getTime() > now.getTime() && !shouldSkipForQuietHours(oneDayAt);

  const oneHourEligible =
    oneHourAt.getTime() > now.getTime() && !shouldSkipForQuietHours(oneHourAt);

  const sendOneHourImmediately =
    within60Minutes && !shouldSkipForQuietHours(now);

  return {
    oneDayAt: oneDayEligible ? oneDayAt : null,
    oneHourAt: oneHourEligible ? oneHourAt : null,
    sendOneHourImmediately,
  };
}
