'use client';

import { useState } from 'react';

import { SafeHoursNotice } from '@/components/common/safe-hours-notice';
import {
    AlertDialog,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { isBenyEligibleSubTier } from '@/constant/tiers';
import { useSafeHours } from '@/hooks/use-safe-hours';
import { trackSignUp } from '@/lib/analytics';
import { type CouponValidationResponse, validateCoupon } from '@/lib/api/resources/coupons';
import { createMembershipCheckout } from '@/lib/api/resources/stripe';
import { ApiError, apiErrorMessage } from '@/lib/api/types';
import { AU_PHONE_MESSAGE, isAuPhone, toAuE164 } from '@/lib/au-phone';
import { CHECKOUT_UNAVAILABLE_MESSAGE, isTrialWindowError } from '@/lib/checkout-errors';
import { SAFE_HOURS_MESSAGE, isSafeHoursError } from '@/lib/safe-hours';
import { goldButtonStyle, inputClassName } from '@/lib/styles';
import { type TierPricing, dollarsOf } from '@/lib/tier-pricing';

import { BENY_PRICE, SignUpFormData, SpinPrize, subTierLabel } from './types';
import { ArrowLeft, CreditCard, Loader2Icon, ShieldCheck, Tag } from 'lucide-react';
import { toast } from 'sonner';

type StepCheckoutProps = {
    data: SignUpFormData;
    pricing: TierPricing;
    spinPrize: SpinPrize | null;

    token: string | null;
    onBack: () => void;
};

const couponDiscountFor = (coupon: CouponValidationResponse, basePrice: number): number => {
    if (coupon.discount.amount_off_cents !== null) {
        return Math.min(coupon.discount.amount_off_cents / 100, basePrice);
    }
    if (coupon.discount.percent_off !== null) {
        return Math.min((basePrice * coupon.discount.percent_off) / 100, basePrice);
    }

    return 0;
};

const couponBadgeLabel = (coupon: CouponValidationResponse, basePrice: number): string => {
    const amount = couponDiscountFor(coupon, basePrice);

    return coupon.discount.percent_off !== null
        ? `${coupon.discount.percent_off}% off (-$${amount.toFixed(2)})`
        : `-$${amount.toFixed(2)}`;
};

const StepCheckout = ({ data, pricing, spinPrize, token, onBack }: StepCheckoutProps) => {
    const [redirecting, setRedirecting] = useState(false);
    const [addBeny, setAddBeny] = useState(false);
    const [benyPhone, setBenyPhone] = useState(data.phone);
    const [benyPhoneError, setBenyPhoneError] = useState<string | null>(null);
    const safeHoursLocked = useSafeHours();

    // A single promo code slot, routed to either membership or BENY by its target.
    const [appliedCoupon, setAppliedCoupon] = useState<CouponValidationResponse | null>(null);
    const [couponCode, setCouponCode] = useState('');
    const [couponApplying, setCouponApplying] = useState(false);
    const [couponError, setCouponError] = useState<string | null>(null);
    const [showConfirmDialog, setShowConfirmDialog] = useState(false);

    // Spin wheel is applied manually and is mutually exclusive with a membership promo.
    const hasSpinPrize = Boolean(spinPrize && spinPrize.discountAmount > 0);
    const [spinApplied, setSpinApplied] = useState(hasSpinPrize);

    const tier = data.tier;
    const subTier = data.sub_tier;
    if (!tier || !subTier) {
        return null;
    }

    const subtotal = dollarsOf(pricing, subTier);
    const canAddBeny = isBenyEligibleSubTier(subTier);
    const willAddBeny = canAddBeny && addBeny;
    const orderSubtotal = subtotal + (willAddBeny ? BENY_PRICE : 0);

    const isMembershipCoupon =
        appliedCoupon?.applies_to_membership === true || appliedCoupon?.target === 'membership';
    const isBenyCoupon =
        appliedCoupon?.applies_to_beny === true || appliedCoupon?.target === 'beny';

    const isSpinDiscountActive = spinApplied && !appliedCoupon && hasSpinPrize && Boolean(spinPrize);

    const membershipCouponDiscount = isMembershipCoupon ? couponDiscountFor(appliedCoupon, subtotal) : 0;
    const spinDiscount = isSpinDiscountActive && spinPrize ? Math.min(spinPrize.discountAmount, subtotal) : 0;
    const membershipDue = Math.max(0, subtotal - membershipCouponDiscount - spinDiscount);

    const benyCouponDiscount = isBenyCoupon && willAddBeny ? couponDiscountFor(appliedCoupon, BENY_PRICE) : 0;
    const benyDue = Math.max(0, BENY_PRICE - benyCouponDiscount);

    // Membership is charged on Stripe now; BENY is charged on activation. Combined for transparency.
    const total = membershipDue + (willAddBeny ? benyDue : 0);

    const handleApplyCoupon = async () => {
        const code = couponCode.trim();
        if (!code) {
            setCouponError('Enter a promo code to apply.');

            return;
        }

        setCouponApplying(true);
        setCouponError(null);
        try {
            const res = await validateCoupon(
                { code, sub_tier_id: subTier.toLowerCase(), has_beny: willAddBeny },
                token ?? undefined
            );

            if (res.applies_to_beny && !res.applies_to_membership && !willAddBeny) {
                setCouponError(
                    "This coupon is only valid for the BENY Add-on. Please check 'Add BENY Add-on' above to use it."
                );

                return;
            }

            setAppliedCoupon(res);
            setCouponCode('');
            setSpinApplied(false);
        } catch (err) {
            setCouponError(
                err instanceof ApiError ? apiErrorMessage(err) : 'Could not apply this code. Please try again.'
            );
        } finally {
            setCouponApplying(false);
        }
    };

    const removeCoupon = () => {
        setAppliedCoupon(null);
        setCouponError(null);
    };

    const handleProceed = () => {
        if (!token) {
            toast.error('Your sign-up session expired. Please start again.');

            return;
        }
        if (willAddBeny && !isAuPhone(benyPhone)) {
            setBenyPhoneError(AU_PHONE_MESSAGE);
            toast.error(AU_PHONE_MESSAGE);

            return;
        }
        setBenyPhoneError(null);
        setShowConfirmDialog(true);
    };

    const handleCheckout = async () => {
        if (!token) {
            toast.error('Your sign-up session expired. Please start again.');

            return;
        }
        if (willAddBeny && !isAuPhone(benyPhone)) {
            setBenyPhoneError(AU_PHONE_MESSAGE);

            return;
        }
        setBenyPhoneError(null);

        const totalDiscount = membershipCouponDiscount + spinDiscount + benyCouponDiscount;

        // Fired before the request, not after: the redirect to Stripe can cut the beacon short.
        trackSignUp({ event: 'sign_up_checkout_initiated', tier, sub_tier: subTier, subtotal, discount: totalDiscount });

        setRedirecting(true);
        try {
            // BENY subscribe runs first; the membership checkout creates the Stripe session.
            if (willAddBeny) {
                const { subscribeBeny } = await import('@/lib/api/resources/beny');
                await subscribeBeny(token, {
                    name: data.name,
                    email: data.email,
                    phone: toAuE164(benyPhone),
                    ...(isBenyCoupon ? { promo_code: appliedCoupon.code } : {})
                });
            }

            const { url } = await createMembershipCheckout(token, {
                sub_tier: subTier.toLowerCase(),
                ...(isMembershipCoupon ? { promo_code: appliedCoupon.code } : {}),
                use_spin_discount: spinApplied
            });

            if (process.env.NODE_ENV === 'development') {
                console.log('[SignUp Checkout Created]', {
                    endpoint: 'POST /api/v1/membership/checkout',
                    payload: {
                        sub_tier: subTier.toLowerCase(),
                        promo_code: isMembershipCoupon ? appliedCoupon.code : undefined,
                        use_spin_discount: spinApplied
                    },
                    url
                });
            }
            window.location.href = url;
        } catch (err) {
            if (process.env.NODE_ENV === 'development') {
                console.error('[SignUp Checkout Error]', {
                    endpoint: 'POST /api/v1/membership/checkout',
                    payload: { sub_tier: subTier.toLowerCase() },
                    error:
                        err instanceof ApiError
                            ? { status: err.status, message: err.message, payload: err.payload }
                            : String(err)
                });
            }

            if (isSafeHoursError(err)) toast.error(SAFE_HOURS_MESSAGE);
            else if (isTrialWindowError(err)) toast.error(CHECKOUT_UNAVAILABLE_MESSAGE);
            else
                toast.error(
                    err instanceof ApiError ? apiErrorMessage(err) : 'Could not open checkout. Please try again.'
                );
            setRedirecting(false);
        }
    };

    return (
        <div className='flex flex-col gap-6'>
            <div>
                <h2 className='font-bebas-neue text-3xl tracking-wider text-white uppercase md:text-4xl'>
                    Review your order
                </h2>
                <p className='text-slr-muted mt-1 text-sm'>
                    You&apos;ll be redirected to Stripe to enter your card details. No charge until you confirm there.
                </p>
            </div>

            <div className='rounded-2xl border border-[#A0B4D259] bg-[linear-gradient(154.36deg,#141820_0.82%,#1E2530_49.73%,#141820_98.65%)] p-6 shadow-[0px_0px_20px_0px_#776D6D26] md:p-8'>
                <div className='space-y-4'>
                    <SummaryRow
                        label={subTierLabel(subTier)}
                        sub='Basic Discounts & Prize Draws — Every 4 Weeks'
                        value={`$${subtotal.toFixed(2)}`}
                    />

                    {willAddBeny ? (
                        <>
                            <div className='h-px w-full bg-white/10' />
                            <SummaryRow
                                label='BENY Add-on'
                                sub='Partner Savings Platform — Billed Separately Every Month'
                                value={`$${BENY_PRICE.toFixed(2)}`}
                            />
                        </>
                    ) : null}

                    <div className='h-px w-full bg-white/10' />

                    <SummaryRow label='Subtotal' value={`$${orderSubtotal.toFixed(2)}`} muted />

                    {isMembershipCoupon && membershipCouponDiscount > 0 ? (
                        <SummaryRow
                            label={`Promo code (${appliedCoupon.code})`}
                            sub='First billing cycle only'
                            value={`-$${membershipCouponDiscount.toFixed(2)}`}
                            highlight
                        />
                    ) : isSpinDiscountActive && spinPrize && spinDiscount > 0 ? (
                        <SummaryRow
                            label='Spin Wheel discount'
                            sub={`${spinPrize.label}, first billing cycle only`}
                            value={`-$${spinDiscount.toFixed(2)}`}
                            highlight
                        />
                    ) : null}

                    {isBenyCoupon && benyCouponDiscount > 0 ? (
                        <SummaryRow
                            label={`Promo code (${appliedCoupon.code}) — BENY`}
                            sub='Applied when BENY activates'
                            value={`-$${benyCouponDiscount.toFixed(2)}`}
                            highlight
                        />
                    ) : null}

                    <div className='h-px w-full bg-white/10' />

                    <div className='flex items-baseline justify-between'>
                        <div>
                            <p className='font-bebas-neue text-xl tracking-wider text-white uppercase'>Due today</p>
                            <p className='text-slr-muted text-xs'>
                                {willAddBeny
                                    ? `Then $${subtotal.toFixed(2)} every 4 weeks (Membership) & $${BENY_PRICE.toFixed(2)}/month (BENY) from your next billing date.`
                                    : `Then $${subtotal.toFixed(2)} every 4 weeks from your next billing date.`}
                            </p>
                        </div>
                        <p className='font-bebas-neue text-3xl font-extrabold text-[#FFDC75]'>${total.toFixed(2)}</p>
                    </div>
                </div>
            </div>

            {canAddBeny ? (
                <div className='flex items-start gap-3 rounded-xl border border-[#D4AF3759] bg-[#D4AF371A]/5 p-4 transition-all hover:bg-[#D4AF371A]/10'>
                    <Checkbox
                        id='beny'
                        checked={addBeny}
                        onCheckedChange={(checked) => {
                            const next = Boolean(checked);
                            setAddBeny(next);
                            if (!next && isBenyCoupon) {
                                setAppliedCoupon(null);
                                setCouponError(null);
                            }
                        }}
                        className='mt-1 border-[#FFD147] data-[state=checked]:bg-[#FFD147] data-[state=checked]:text-[#131619]'
                    />
                    <div className='grid gap-1.5 leading-none'>
                        <label
                            htmlFor='beny'
                            className='cursor-pointer text-sm font-bold tracking-wide text-white uppercase select-none'>
                            Add BENY Add-on — +${BENY_PRICE.toFixed(2)}/month
                        </label>
                        <p className='text-slr-muted text-xs leading-relaxed'>
                            Access premium brand discounts through the BENY app. Billed directly to your card on Stripe
                            (+$
                            {BENY_PRICE.toFixed(2)}/mo). Access requires manual activation and confirmation by an SLR
                            Admin after registration.
                        </p>

                        {addBeny ? (
                            <div className='mt-2'>
                                <label htmlFor='beny-phone' className='text-slr-muted text-xs font-semibold'>
                                    Phone number for BENY activation
                                </label>
                                <Input
                                    id='beny-phone'
                                    type='tel'
                                    className={`${inputClassName} mt-1.5`}
                                    placeholder='0412 345 678'
                                    aria-invalid={benyPhoneError ? true : undefined}
                                    value={benyPhone}
                                    onChange={(e) => {
                                        setBenyPhone(e.target.value);
                                        if (benyPhoneError) setBenyPhoneError(null);
                                    }}
                                />
                                {benyPhoneError ? (
                                    <p className='mt-1 text-xs text-red-400'>{benyPhoneError}</p>
                                ) : (
                                    <p className='text-slr-dim mt-1 text-xs'>
                                        This is the number our admin uses to invite you on BENY. Change it if BENY
                                        should reach you on a different number.
                                    </p>
                                )}
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}

            <div className='rounded-xl border border-white/10 bg-white/5 p-4'>
                <div className='flex items-center gap-2 text-sm font-bold tracking-wide text-white uppercase'>
                    <Tag className='h-4 w-4 text-[#FFDC75]' />
                    Promo code
                </div>

                {appliedCoupon ? (
                    <div className='mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3'>
                        <div className='flex flex-wrap items-center gap-2 text-sm'>
                            <span className='font-mono font-bold text-emerald-300 uppercase'>
                                {appliedCoupon.code}
                            </span>
                            <span className='text-emerald-200/90'>
                                {couponBadgeLabel(appliedCoupon, isBenyCoupon ? BENY_PRICE : subtotal)}
                            </span>
                            <span className='text-emerald-200/60 text-xs'>
                                ({isBenyCoupon ? 'BENY' : 'Membership'})
                            </span>
                        </div>
                        <button
                            type='button'
                            onClick={removeCoupon}
                            disabled={redirecting}
                            className='text-xs font-semibold text-emerald-200 underline-offset-2 hover:underline disabled:opacity-50'>
                            Remove
                        </button>
                    </div>
                ) : isSpinDiscountActive && spinPrize ? (
                    <div className='mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3'>
                        <div className='flex flex-wrap items-center gap-2 text-sm'>
                            <span className='font-mono font-bold text-emerald-300 uppercase'>
                                SPIN WHEEL
                            </span>
                            <span className='text-emerald-200/90'>
                                -${Math.min(spinPrize.discountAmount, subtotal).toFixed(2)}
                            </span>
                            <span className='text-emerald-200/60 text-xs'>
                                (Membership)
                            </span>
                        </div>
                        <button
                            type='button'
                            onClick={() => setSpinApplied(false)}
                            disabled={redirecting}
                            className='text-xs font-semibold text-emerald-200 underline-offset-2 hover:underline disabled:opacity-50'>
                            Remove
                        </button>
                    </div>
                ) : (
                    <>
                        <div className='mt-3 flex gap-2'>
                            <Input
                                type='text'
                                className={inputClassName}
                                placeholder='Enter promo code'
                                value={couponCode}
                                onChange={(e) => {
                                    setCouponCode(e.target.value);
                                    if (couponError) setCouponError(null);
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void handleApplyCoupon();
                                    }
                                }}
                            />
                            <Button
                                type='button'
                                onClick={handleApplyCoupon}
                                disabled={couponApplying || redirecting}
                                style={goldButtonStyle}
                                className='h-11 shrink-0 rounded-xl px-5 font-bold uppercase shadow-md transition-opacity hover:opacity-90 disabled:opacity-70 text-[#1a1408]'>
                                {couponApplying ? <Loader2Icon className='animate-spin' /> : 'Apply'}
                            </Button>
                        </div>

                        {couponError ? <p className='mt-2 text-xs text-red-400'>{couponError}</p> : null}

                        {hasSpinPrize && spinPrize ? (
                            <div className='mt-2.5'>
                                <button
                                    type='button'
                                    onClick={() => {
                                        setSpinApplied(true);
                                        setCouponError(null);
                                        setCouponCode('');
                                    }}
                                    disabled={redirecting}
                                    className='inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs font-semibold text-[#FFDC75] transition-colors hover:border-white/20 hover:bg-white/10 disabled:opacity-50'>
                                    <Tag className='size-3.5 text-[#FFDC75]' />
                                    <span>
                                        Use Spin Wheel discount (-$
                                        {Math.min(spinPrize.discountAmount, subtotal).toFixed(2)})
                                    </span>
                                </button>
                            </div>
                        ) : null}
                    </>
                )}
            </div>

            {safeHoursLocked ? <SafeHoursNotice /> : null}

            <div className='flex flex-wrap gap-3'>
                <Button
                    type='button'
                    variant='outline'
                    onClick={onBack}
                    disabled={redirecting}
                    className='h-11 min-w-max flex-1 rounded-xl border border-white/10 bg-white/5 px-6 font-semibold text-white hover:bg-white/10 hover:text-white sm:flex-none'>
                    <ArrowLeft className='h-4 w-4' />
                    Back
                </Button>
                <Button
                    type='button'
                    onClick={handleProceed}
                    disabled={redirecting || safeHoursLocked}
                    style={goldButtonStyle}
                    className='h-11 min-w-max flex-1 rounded-xl font-bold uppercase shadow-md transition-opacity hover:opacity-90 disabled:opacity-70 text-[#1a1408]'>
                    {redirecting ? (
                        <>
                            <Loader2Icon className='animate-spin' /> Redirecting to Stripe…
                        </>
                    ) : (
                        <>
                            <CreditCard className='h-4 w-4' />
                            Complete Payment
                        </>
                    )}
                </Button>
            </div>

            <AlertDialog open={showConfirmDialog} onOpenChange={redirecting ? undefined : setShowConfirmDialog}>
                <AlertDialogContent className='rounded-2xl border border-[#A0B4D259] bg-[linear-gradient(154.36deg,#141820_0.82%,#1E2530_49.73%,#141820_98.65%)] p-6 text-white shadow-[0px_0px_20px_0px_#776D6D26] sm:max-w-md'>
                    <AlertDialogHeader className='text-left'>
                        <AlertDialogTitle className='font-bebas-neue text-2xl tracking-wider text-white uppercase'>
                            Payment & Activation Notice
                        </AlertDialogTitle>
                        <AlertDialogDescription className='text-slr-muted text-sm' asChild>
                            <div className='space-y-3 pt-1'>
                                <p className='text-slr-muted text-xs leading-relaxed'>
                                    Please review the payment and activation schedule for your order before proceeding:
                                </p>
                                <div className='rounded-xl border border-[#D4AF3759] bg-[#D4AF371A]/10 p-3.5 text-xs leading-relaxed text-[#FFDC75]'>
                                    <ul className='space-y-1.5 font-medium'>
                                        <li>• Charged and activated now after payment: ${membershipDue.toFixed(2)}</li>
                                        {willAddBeny ? (
                                            <li>
                                                • Charged and activated within 12 hours after payment: ${benyDue.toFixed(2)}
                                                {isBenyCoupon ? ' (after promo code discount)' : ''}
                                            </li>
                                        ) : null}
                                    </ul>
                                </div>
                            </div>
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter className='mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3'>
                        <Button
                            type='button'
                            variant='ghost'
                            disabled={redirecting}
                            onClick={() => setShowConfirmDialog(false)}
                            className='h-11 rounded-xl px-5 text-xs font-semibold uppercase tracking-wider text-slr-muted transition-colors hover:bg-white/5 hover:text-white sm:text-sm'>
                            Back
                        </Button>
                        <Button
                            type='button'
                            disabled={redirecting || safeHoursLocked}
                            onClick={handleCheckout}
                            style={goldButtonStyle}
                            className='h-11 min-w-[170px] rounded-xl font-bold uppercase shadow-md transition-opacity hover:opacity-90 disabled:opacity-70 text-[#1a1408]'>
                            {redirecting ? (
                                <>
                                    <Loader2Icon className='animate-spin' /> Redirecting to Stripe…
                                </>
                            ) : (
                                'Complete Payment'
                            )}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            <p className='text-slr-dim flex items-center justify-center gap-1.5 text-center text-xs'>
                <ShieldCheck className='h-3.5 w-3.5' />
                Payment processed securely by Stripe. We never store your card details.
            </p>
        </div>
    );
};

type SummaryRowProps = {
    label: string;
    sub?: string;
    value: string;
    muted?: boolean;
    highlight?: boolean;
};

const SummaryRow = ({ label, sub, value, muted, highlight }: SummaryRowProps) => (
    <div className='flex items-baseline justify-between gap-3'>
        <div>
            <p className={muted ? 'text-slr-muted text-sm' : 'text-sm font-medium text-white'}>{label}</p>
            {sub && <p className='text-slr-dim text-xs'>{sub}</p>}
        </div>
        <p
            className={
                highlight
                    ? 'text-sm font-bold text-[#FFDC75]'
                    : muted
                      ? 'text-slr-muted text-sm'
                      : 'text-sm font-semibold text-white'
            }>
            {value}
        </p>
    </div>
);

export default StepCheckout;
