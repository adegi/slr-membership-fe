import { API } from '../endpoints';
import { apiFetch } from '../http';

export type CheckoutTier = 'RED' | 'BLUE';

export interface CheckoutSession {
    url: string;
    sessionId?: string;
}

export interface PortalSession {
    url: string;
}

export interface MembershipCheckoutPayload {
    sub_tier?: string;
    tier?: CheckoutTier;
    promo_code?: string;
    use_spin_discount?: boolean;
}

export const createMembershipCheckout = (token: string, body: MembershipCheckoutPayload) =>
    apiFetch<CheckoutSession>(API.memberships.checkout, { method: 'POST', token, body });

export const createCheckoutSession = (token: string, body: { tier: CheckoutTier; couponId?: string }) =>
    apiFetch<CheckoutSession>(API.stripe.checkout, { method: 'POST', token, body });

export const createPortalSession = (token: string) =>
    apiFetch<PortalSession>(API.stripe.portal, { method: 'POST', token });
