import { API } from '../endpoints';
import { apiFetch } from '../http';

export type CouponTarget = 'membership' | 'beny';

export interface CouponDiscountDetails {
    amount_off_cents: number | null;
    percent_off: number | null;
    currency: string | null;
}

export interface CouponValidationRequest {
    code: string;
    sub_tier_id?: string;
    has_beny?: boolean;
}

export interface CouponValidationResponse {
    valid: true;
    target: CouponTarget;
    applies_to_membership?: boolean;
    applies_to_beny?: boolean;
    promotion_code_id: string | null;
    coupon_id: string;
    code: string;
    discount: CouponDiscountDetails;
}

export const validateCoupon = (body: CouponValidationRequest, token?: string) =>
    apiFetch<CouponValidationResponse>(API.coupons.validate, {
        method: 'POST',
        body,
        ...(token ? { token } : {})
    });
