import { cache } from 'react';

import { API } from '../endpoints';
import { apiFetch } from '../http';

export type BenyStatusValue =
    | 'inactive'
    // Returned right after subscribe while the backend completes payment on its side.
    | 'pending_payment'
    | 'pending_activation'
    | 'active'
    | 'pending_deactivation'
    | 'cancelled'
    | 'canceled';

export const isBenyCancelled = (status: BenyStatusValue) => status === 'cancelled' || status === 'canceled';

export const isBenyWindingDown = (status: BenyStatusValue) => status === 'pending_deactivation';

export interface BenyStatusResponse {
    beny_status: BenyStatusValue;
    activated_at?: string | null;
    cancelled_at?: string | null;
    expires_at?: string | null;
    deactivated_at?: string | null;
    /** True when a 3DS/OTP payment is awaiting the member on Stripe's hosted invoice. */
    requires_action?: boolean;
    /** Stripe hosted invoice URL the member must visit to complete the 3DS payment. */
    payment_url?: string | null;
}

export interface BenySubscribeResponse extends BenyStatusResponse {
    checkout_url?: string | null;
    session_id?: string | null;
}

export interface BenySubscribePayload {
    name: string;
    email: string;
    phone: string;
    promo_code?: string;
}

export const getBenyStatus = cache((token: string) =>
    apiFetch<BenyStatusResponse>(API.beny.status, { token, cache: 'no-store' })
);

export const subscribeBeny = (token: string, body: BenySubscribePayload) =>
    apiFetch<BenySubscribeResponse>(API.beny.subscribe, { method: 'POST', token, body });

export const cancelBeny = (token: string, options?: { hardDelete?: boolean }) => {
    const hardDelete = options?.hardDelete === true;
    const path = hardDelete ? `${API.beny.subscribe}?hardDelete=true` : API.beny.subscribe;

    return apiFetch<{ success?: boolean; message?: string } | null>(path, { method: 'DELETE', token });
};
