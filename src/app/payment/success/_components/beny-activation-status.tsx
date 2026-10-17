'use client';

import { useEffect, useState } from 'react';

import Link from 'next/link';

import EmptyState from '@/components/common/empty-state';
import GoldCtaButton from '@/components/common/gold-cta-button';
import { type BenyActivationState, checkBenyActivation } from '../actions';
import { CheckCircle2, Loader2 } from 'lucide-react';

const MAX_TRIES = 5;
const INTERVAL_MS = 2000;

type Phase = 'polling' | 'pending_activation' | 'active' | 'unauthed';

const SecondaryLink = ({ href, children }: { href: string; children: string }) => (
    <Link href={href} className='text-slr-dim text-sm transition-colors hover:text-white'>
        {children}
    </Link>
);

export function BenyActivationStatus() {
    const [phase, setPhase] = useState<Phase>('polling');
    const [, setDetail] = useState<BenyActivationState | null>(null);

    useEffect(() => {
        let cancelled = false;
        let tries = 0;
        let timer: ReturnType<typeof setTimeout>;

        const poll = async () => {
            const res = await checkBenyActivation();
            if (cancelled) return;
            setDetail(res);

            if (!res.authed) return setPhase('unauthed');
            if (res.benyStatus === 'active') return setPhase('active');
            if (res.benyStatus === 'pending_activation') return setPhase('pending_activation');

            tries += 1;
            if (tries >= MAX_TRIES) {
                // Stripe payment setup succeeded; default to pending_activation even if backend poll is slow.
                return setPhase('pending_activation');
            }
            timer = setTimeout(poll, INTERVAL_MS);
        };

        poll();

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, []);

    if (phase === 'polling') {
        return (
            <div className='border-slr-navy-border bg-slr-navy-card mx-auto flex max-w-md flex-col items-center rounded-2xl border px-6 py-12 text-center'>
                <div className='bg-gold-tint mb-4 flex size-14 items-center justify-center rounded-2xl border border-[#D4AF3759]'>
                    <Loader2 className='text-slr-gold-label size-7 animate-spin' />
                </div>
                <h3 className='font-bebas-neue text-2xl tracking-wider text-white uppercase'>Confirming BENY Setup</h3>
                <p className='text-slr-muted mt-2 text-sm leading-relaxed'>
                    Confirming your BENY payment setup — this takes a few seconds.
                </p>
            </div>
        );
    }

    if (phase === 'active') {
        return (
            <EmptyState
                icon={CheckCircle2}
                title='BENY Setup Successful'
                description='Your BENY add-on is now active on your account. Download the BENY app to start accessing member discounts.'
                action={
                    <div className='flex flex-col items-center gap-3'>
                        <GoldCtaButton href='/member' className='w-full max-w-xs'>
                            Go to Dashboard
                        </GoldCtaButton>
                    </div>
                }
            />
        );
    }

    if (phase === 'unauthed') {
        return (
            <EmptyState
                icon={CheckCircle2}
                title='BENY Setup Successful'
                description='Your payment setup went through. Sign in to access your discounts and account.'
                action={
                    <div className='flex flex-col items-center gap-3'>
                        <GoldCtaButton href='/sign-in' className='w-full max-w-xs'>
                            Sign in
                        </GoldCtaButton>
                        <SecondaryLink href='/'>Return home</SecondaryLink>
                    </div>
                }
            />
        );
    }

    return (
        <EmptyState
            icon={CheckCircle2}
            title='BENY Setup Successful'
            description="Your payment setup for the BENY add-on is complete. Your account is pending activation (usually within 1 business day). We'll email your access details once active."
            action={
                <div className='flex flex-col items-center gap-3'>
                    <GoldCtaButton href='/member' className='w-full max-w-xs'>
                        Go to Dashboard
                    </GoldCtaButton>
                </div>
            }
        />
    );
}
