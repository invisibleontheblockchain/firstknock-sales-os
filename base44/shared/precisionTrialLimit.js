// One-time support credits extend the lifetime included bucket. They never
// renew with a billing period or grant paid features.
export function precisionTrialLimit(user) {
    const bonus = Number(user?.precision_trial_bonus_credits || 0);
    return 50 + (Number.isSafeInteger(bonus) && bonus > 0 && bonus <= 1000000 ? bonus : 0);
}
