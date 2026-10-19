'use server';

import { getMe } from '@/lib/api/resources/auth';
import { cancelBeny, subscribeBeny } from '@/lib/api/resources/beny';
import { type CouponValidationResponse, validateCoupon } from '@/lib/api/resources/coupons';
import {
    type ResetCompletePaymentAction,
    resetCompletePayment
} from '@/lib/api/resources/memberships';
import { createMembershipCheckout } from '@/lib/api/resources/stripe';
import { getAccessToken } from '@/lib/api/server';
import { ApiError, apiErrorMessage } from '@/lib/api/types';
import { toAuE164 } from '@/lib/au-phone';
import { CHECKOUT_UNAVAILABLE_MESSAGE, isTrialWindowError } from '@/lib/checkout-errors';
import { SAFE_HOURS_MESSAGE, isSafeHoursError } from '@/lib/safe-hours';

export async function resetCompletePaymentAction(
    action: ResetCompletePaymentAction
): Promise<{ ok: boolean; message?: string }> {
    const token = await getAccessToken();
    if (!token) return { ok: false, message: 'Not authenticated.' };

    try {
        await resetCompletePayment(token, action);

        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            message: error instanceof ApiError ? apiErrorMessage(error) : 'Could not reset checkout state.'
        };
    }
}

export async function hardDeleteBenyAction(): Promise<{ ok: boolean; message?: string }> {
    const token = await getAccessToken();
    if (!token) return { ok: false, message: 'Not authenticated.' };

    try {
        await cancelBeny(token, { hardDelete: true });

        return { ok: true };
    } catch (error) {
        return {
            ok: false,
            message: error instanceof ApiError ? apiErrorMessage(error) : 'Could not remove BENY.'
        };
    }
}

export async function validateCouponAction(body: {
    code: string;
    sub_tier_id?: string;
    has_beny?: boolean;
}): Promise<{ ok: true; coupon: CouponValidationResponse } | { ok: false; message: string }> {
    const token = await getAccessToken();
    if (!token) return { ok: false, message: 'Not authenticated.' };

    try {
        const coupon = await validateCoupon(body, token);

        return { ok: true, coupon };
    } catch (error) {
        return {
            ok: false,
            message:
                error instanceof ApiError ? apiErrorMessage(error) : 'Could not apply this code. Please try again.'
        };
    }
}

export interface CompletePaymentCheckoutPayload {
    subTier: string;
    hasBeny: boolean;
    benyPhone?: string;
    promoCode?: string;
    benyPromoCode?: string;
    useSpinDiscount?: boolean;
}

export async function completePaymentCheckoutAction(
    payload: CompletePaymentCheckoutPayload
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
    const token = await getAccessToken();
    if (!token) return { ok: false, message: 'Not authenticated.' };

    try {
        if (payload.hasBeny) {
            const me = await getMe(token);
            await subscribeBeny(token, {
                name: me.full_name,
                email: me.email,
                phone: toAuE164(payload.benyPhone ?? me.phone),
                promo_code: payload.benyPromoCode
            });
        }

        const { url } = await createMembershipCheckout(token, {
            sub_tier: payload.subTier.toLowerCase(),
            promo_code: payload.promoCode,
            use_spin_discount: payload.useSpinDiscount
        });

        return { ok: true, url };
    } catch (error) {
        if (isSafeHoursError(error)) return { ok: false, message: SAFE_HOURS_MESSAGE };
        if (isTrialWindowError(error)) return { ok: false, message: CHECKOUT_UNAVAILABLE_MESSAGE };

        return {
            ok: false,
            message: error instanceof ApiError ? apiErrorMessage(error) : 'Could not start checkout.'
        };
    }
}

export async function startMembershipCheckout(
    subTier?: string
): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
    return completePaymentCheckoutAction({
        subTier: subTier ?? 'r1',
        hasBeny: false
    });
}
