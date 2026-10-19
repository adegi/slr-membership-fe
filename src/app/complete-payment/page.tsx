import type { Metadata } from 'next';

import { auth } from '@/auth';
import { handleApiAuthError } from '@/lib/api/guard';
import { getMe } from '@/lib/api/resources/auth';
import {
    type CompletePaymentStateResponse,
    getCompletePaymentState,
    getMyMembership
} from '@/lib/api/resources/memberships';
import { getAccessToken } from '@/lib/api/server';
import { subTierCodeOf } from '@/lib/member';
import { getTierPricing } from '@/lib/tier-pricing';

import ActivatedRedirect from './_components/activated-redirect';
import CompletePaymentClient from './_components/complete-payment-client';

export const metadata: Metadata = {
    title: 'Complete your payment',
    robots: { index: false }
};

type SearchParams = { status?: string };

export default async function CompletePaymentPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
    const { status } = await searchParams;
    const session = await auth();
    const token = await getAccessToken();
    const pricing = await getTierPricing();

    let subTierId: string | undefined;
    let completePaymentState: CompletePaymentStateResponse | null = null;
    let userPhone = '';
    let userName = '';
    let userEmail = '';

    let alreadyPaid = false;
    if (token) {
        try {
            const [membership, me, cpState] = await Promise.all([
                getMyMembership(token),
                getMe(token).catch(() => null),
                getCompletePaymentState(token).catch(() => null)
            ]);
            completePaymentState = cpState;
            subTierId = cpState?.membership?.sub_tier_id ?? membership.subTierId;
            alreadyPaid = me ? me.requires_payment !== true : membership.billingStatus?.toLowerCase() === 'active';
            userPhone = me?.phone ?? '';
            userName = me?.full_name ?? '';
            userEmail = me?.email ?? '';
        } catch (error) {
            handleApiAuthError(error);
        }
    }

    if (alreadyPaid) {
        return (
            <main className='dark bg-slr-navy-deep flex min-h-svh flex-col items-center justify-center px-4 py-12'>
                <ActivatedRedirect />
            </main>
        );
    }

    const subTier = subTierCodeOf(
        subTierId ?? (session?.user as { sub_tier?: string } | undefined)?.sub_tier
    );
    const firstName = (userName || session?.user?.name || '').trim().split(' ')[0];

    const expired = status === 'expired';
    const cancelled = status === 'cancelled';

    return (
        <main className='dark bg-slr-navy-deep flex min-h-svh flex-col items-center justify-center px-4 py-12'>
            <div className='w-full max-w-xl rounded-2xl border border-[#A0B4D259] bg-[linear-gradient(154.36deg,#141820_0.82%,#1E2530_49.73%,#141820_98.65%)] p-6 shadow-[0px_0px_20px_0px_#776D6D26] md:p-8'>
                <h1 className='font-bebas-neue text-3xl tracking-wider text-white uppercase md:text-4xl'>
                    {expired
                        ? 'Payment link expired'
                        : cancelled
                          ? 'No worries — nothing has been charged'
                          : `Review your order${firstName ? `, ${firstName}` : ''}`}
                </h1>

                <p className='text-slr-muted mt-2 text-sm'>
                    {expired
                        ? 'Your previous checkout link has expired. Review your details and start a fresh checkout below.'
                        : cancelled
                          ? 'Your account is saved. You can review your details, adjust your plan or add-ons, and complete payment when you’re ready.'
                          : 'Your SLR account is ready. Review your plan and add-ons below, then proceed to Stripe to complete your payment.'}
                </p>

                <div className='mt-6'>
                    <CompletePaymentClient
                        initialSubTier={subTier}
                        pricing={pricing}
                        completePaymentState={completePaymentState}
                        userPhone={userPhone || (session?.user as { phone?: string } | undefined)?.phone || ''}
                        userName={userName || session?.user?.name || ''}
                        userEmail={userEmail || session?.user?.email || ''}
                        statusParam={status}
                    />
                </div>
            </div>
        </main>
    );
}
