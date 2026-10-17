import type { Metadata } from 'next';

import { ActivationStatus } from './_components/activation-status';
import { BenyActivationStatus } from './_components/beny-activation-status';

export const metadata: Metadata = {
    title: 'Payment Successful',
    robots: { index: false }
};

interface PaymentSuccessPageProps {
    searchParams?: Promise<{
        beny_session_id?: string;
        session_id?: string;
        [key: string]: string | string[] | undefined;
    }>;
}

export default async function PaymentSuccessPage({ searchParams }: PaymentSuccessPageProps) {
    const params = searchParams ? await searchParams : {};
    const isBeny = typeof params.beny_session_id === 'string' && params.beny_session_id.length > 0;

    return (
        <main className='dark bg-slr-ink flex min-h-svh flex-col items-center justify-center px-4 py-12'>
            {isBeny ? <BenyActivationStatus /> : <ActivationStatus />}
        </main>
    );
}
