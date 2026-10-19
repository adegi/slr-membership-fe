'use client';

import { useState } from 'react';

import Image from 'next/image';

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
import {
    BENY_MONTHLY_PRICE,
    SUB_TIERS,
    isBenyEligibleSubTier,
    isStandardSubTier
} from '@/constant/tiers';
import { useSafeHours } from '@/hooks/use-safe-hours';
import { type CouponValidationResponse } from '@/lib/api/resources/coupons';
import type { CompletePaymentStateResponse } from '@/lib/api/resources/memberships';
import { ApiError, apiErrorMessage } from '@/lib/api/types';
import { AU_PHONE_MESSAGE, isAuPhone, toAuE164 } from '@/lib/au-phone';
import { subTierCodeOf } from '@/lib/member';
import { goldButtonStyle, inputClassName } from '@/lib/styles';
import { type TierPricing, dollarsOf } from '@/lib/tier-pricing';
import type { SubTierCode } from '@/types/member';

import {
    completePaymentCheckoutAction,
    hardDeleteBenyAction,
    resetCompletePaymentAction,
    validateCouponAction
} from '../actions';
import {
    AlertCircle,
    CreditCard,
    Loader2Icon,
    ShieldCheck,
    Tag,
    X
} from 'lucide-react';
import { toast } from 'sonner';

const PAID_CODES: SubTierCode[] = ['R1', 'R4', 'R7', 'B1', 'B4', 'B7', 'B10'];
const BENY_PRICE = BENY_MONTHLY_PRICE;

const planLabel = (code: SubTierCode) => {
    const meta = SUB_TIERS[code];

    return `SLR ${meta.group === 'red' ? 'RED' : 'BLUE'} · ${meta.marketingName}`;
};

const priceLabel = (pricing: TierPricing, code: SubTierCode) =>
    `$${(pricing[code].priceCents / 100).toFixed(0)}`;

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

type CompletePaymentClientProps = {
    initialSubTier: SubTierCode;
    pricing: TierPricing;
    completePaymentState: CompletePaymentStateResponse | null;
    userPhone: string;
    userName: string;
    userEmail: string;
    statusParam?: string;
};

const CompletePaymentClient = ({
    initialSubTier,
    pricing,
    completePaymentState,
    userPhone,
    statusParam
}: CompletePaymentClientProps) => {
    // 1. Restore sub-tier
    const restoredCode = completePaymentState?.membership?.sub_tier_id
        ? subTierCodeOf(completePaymentState.membership.sub_tier_id)
        : initialSubTier;
    const [selectedSubTier, setSelectedSubTier] = useState<SubTierCode>(restoredCode);
    const [picking, setPicking] = useState(false);
    const [busyReset, setBusyReset] = useState(false);
    const [pendingTierChange, setPendingTierChange] = useState<SubTierCode | null>(null);

    // 2. Restore BENY state
    const initialCanAddBeny = isBenyEligibleSubTier(restoredCode);
    const initialHasBeny =
        initialCanAddBeny &&
        Boolean(completePaymentState?.beny && completePaymentState.beny.status !== 'cancelled');
    const [hasBeny, setHasBeny] = useState(initialHasBeny);
    const [benyPhone, setBenyPhone] = useState(
        completePaymentState?.beny?.phone || userPhone || ''
    );
    const [benyPhoneError, setBenyPhoneError] = useState<string | null>(null);

    // 3. Restore spin discount state
    const spinRecord = completePaymentState?.spin;
    const spinExpired = spinRecord?.expires_at
        ? new Date(spinRecord.expires_at).getTime() <= Date.now()
        : false;
    const initialSpinPrize =
        spinRecord && !spinExpired
            ? {
                  label: 'Spin Wheel win',
                  discountAmount: spinRecord.discount_cents / 100
              }
            : null;
    const [spinPrize, setSpinPrize] = useState(initialSpinPrize);

    // 4. Restore promo code state
    const promoRecord = completePaymentState?.promo;
    const initialCoupon: CouponValidationResponse | null =
        promoRecord && promoRecord.valid && promoRecord.target
            ? {
                  valid: true,
                  target: promoRecord.target,
                  promotion_code_id:
                      completePaymentState?.membership?.pending_stripe_promotion_code_id ?? null,
                  coupon_id:
                      completePaymentState?.membership?.pending_stripe_coupon_id ?? '',
                  code: promoRecord.code,
                  discount: {
                      amount_off_cents: promoRecord.amount_off_cents,
                      percent_off: promoRecord.percent_off,
                      currency: 'aud'
                  }
              }
            : null;
    const [appliedCoupon, setAppliedCoupon] = useState<CouponValidationResponse | null>(
        initialCoupon
    );
    const [couponCode, setCouponCode] = useState('');
    const [couponApplying, setCouponApplying] = useState(false);
    const [couponError, setCouponError] = useState<string | null>(null);

    // Initial spinApplied: true only if spin won, not expired, and coupon not active
    const initialSpinApplied = Boolean(initialSpinPrize && !initialCoupon);
    const [spinApplied, setSpinApplied] = useState(initialSpinApplied);

    // 5. Dismissible alert banners
    const [showSessionExpiredAlert, setShowSessionExpiredAlert] = useState(
        statusParam === 'expired'
    );
    const [showPromoExpiredAlert, setShowPromoExpiredAlert] = useState(
        Boolean(promoRecord && !promoRecord.valid)
    );
    const [showSpinExpiredAlert, setShowSpinExpiredAlert] = useState(
        Boolean(spinRecord && spinExpired)
    );

    const [redirecting, setRedirecting] = useState(false);
    const [showConfirmDialog, setShowConfirmDialog] = useState(false);
    const safeHoursLocked = useSafeHours();

    // Calculations
    const canAddBeny = isBenyEligibleSubTier(selectedSubTier);
    const willAddBeny = canAddBeny && hasBeny;
    const subtotal = dollarsOf(pricing, selectedSubTier);
    const orderSubtotal = subtotal + (willAddBeny ? BENY_PRICE : 0);

    const hasSpinPrize = Boolean(spinPrize && spinPrize.discountAmount > 0);
    const isSpinDiscountActive = spinApplied && !appliedCoupon && hasSpinPrize && Boolean(spinPrize);

    const isMembershipCoupon = appliedCoupon?.target === 'membership';
    const isBenyCoupon = appliedCoupon?.target === 'beny';

    const membershipCouponDiscount = isMembershipCoupon
        ? couponDiscountFor(appliedCoupon, subtotal)
        : 0;
    const spinDiscount = isSpinDiscountActive && spinPrize
        ? Math.min(spinPrize.discountAmount, subtotal)
        : 0;
    const membershipDue = Math.max(
        0,
        subtotal - membershipCouponDiscount - spinDiscount
    );

    const benyCouponDiscount =
        isBenyCoupon && willAddBeny ? couponDiscountFor(appliedCoupon, BENY_PRICE) : 0;
    const benyDue = Math.max(0, BENY_PRICE - benyCouponDiscount);

    const total = membershipDue + (willAddBeny ? benyDue : 0);

    // In-place plan change handlers
    const handleRequestTierChange = (code: SubTierCode) => {
        if (code === selectedSubTier) {
            setPicking(false);

            return;
        }

        setPendingTierChange(code);
    };

    const executeTierChange = async () => {
        if (!pendingTierChange) return;
        const code = pendingTierChange;

        setBusyReset(true);
        try {
            await resetCompletePaymentAction('change-tier');

            // Reset discounts in UI
            setAppliedCoupon(null);
            setSpinApplied(false);
            setSpinPrize(null);

            // Protection: if standard tier (R1 or B1), remove BENY
            if (isStandardSubTier(code)) {
                if (hasBeny) {
                    setHasBeny(false);
                    await hardDeleteBenyAction();
                    toast.info(
                        'Switched plan. BENY add-on is not available for Standard plan and was removed.'
                    );
                } else {
                    toast.info('Plan switched. Cart and discounts have been reset.');
                }
            } else {
                toast.info('Plan switched. Cart and discounts have been reset.');
            }

            setSelectedSubTier(code);
            setPicking(false);
            setPendingTierChange(null);
        } catch {
            toast.error('Could not change plan. Please try again.');
        } finally {
            setBusyReset(false);
        }
    };

    // BENY toggle handler
    const handleToggleBeny = async (checked: boolean) => {
        setHasBeny(checked);
        if (!checked) {
            if (isBenyCoupon) {
                setAppliedCoupon(null);
                setCouponError(null);
            }
            try {
                await hardDeleteBenyAction();
                await resetCompletePaymentAction('change-beny');
                toast.info('BENY add-on removed.');
            } catch {
                toast.error('Could not update BENY add-on.');
            }
        }
    };

    // Coupon handlers
    const handleApplyCoupon = async () => {
        const code = couponCode.trim();
        if (!code) {
            setCouponError('Enter a promo code to apply.');

            return;
        }

        setCouponApplying(true);
        setCouponError(null);
        try {
            const res = await validateCouponAction({
                code,
                sub_tier_id: selectedSubTier.toLowerCase(),
                has_beny: willAddBeny
            });

            if (!res.ok) {
                setCouponError(res.message);

                return;
            }

            if (res.coupon.target === 'beny' && !willAddBeny) {
                setCouponError(
                    "This coupon is only valid for the BENY Add-on. Please check 'Add BENY Add-on' above to use it."
                );

                return;
            }

            setAppliedCoupon(res.coupon);
            setCouponCode('');
            setSpinApplied(false);
        } finally {
            setCouponApplying(false);
        }
    };

    const handleRemoveCoupon = async () => {
        setAppliedCoupon(null);
        setCouponError(null);
        try {
            await resetCompletePaymentAction('change-promo');
        } catch {
            // Ignore background reset errors
        }
    };

    const handleProceed = () => {
        if (willAddBeny && !isAuPhone(benyPhone)) {
            setBenyPhoneError(AU_PHONE_MESSAGE);
            toast.error(AU_PHONE_MESSAGE);

            return;
        }
        setBenyPhoneError(null);
        setShowConfirmDialog(true);
    };

    // Final checkout submission
    const handleCheckout = async () => {
        if (willAddBeny && !isAuPhone(benyPhone)) {
            setBenyPhoneError(AU_PHONE_MESSAGE);

            return;
        }
        setBenyPhoneError(null);

        setRedirecting(true);
        try {
            const res = await completePaymentCheckoutAction({
                subTier: selectedSubTier.toLowerCase(),
                hasBeny: willAddBeny,
                benyPhone: willAddBeny ? benyPhone : undefined,
                promoCode: isMembershipCoupon ? appliedCoupon.code : undefined,
                benyPromoCode: isBenyCoupon ? appliedCoupon.code : undefined,
                useSpinDiscount: spinApplied && !isMembershipCoupon
            });

            if (!res.ok) {
                toast.error(res.message);
                setRedirecting(false);

                return;
            }

            window.location.href = res.url;
        } catch (err) {
            toast.error(
                err instanceof ApiError ? apiErrorMessage(err) : 'Could not proceed to checkout.'
            );
            setRedirecting(false);
        }
    };

    const selectedMeta = SUB_TIERS[selectedSubTier];

    if (picking) {
        return (
            <div className='flex flex-col gap-4'>
                <div className='flex items-center justify-between'>
                    <p className='text-slr-dim text-xs font-bold tracking-widest uppercase'>
                        Choose a new plan
                    </p>
                    <button
                        type='button'
                        disabled={busyReset}
                        onClick={() => setPicking(false)}
                        className='text-slr-muted hover:text-white text-xs underline-offset-2 hover:underline'>
                        Cancel
                    </button>
                </div>

                <div className='grid grid-cols-1 gap-2.5'>
                    {PAID_CODES.map((code) => {
                        const meta = SUB_TIERS[code];
                        const isSelected = code === selectedSubTier;

                        return (
                            <button
                                key={code}
                                type='button'
                                disabled={busyReset || safeHoursLocked}
                                onClick={() => handleRequestTierChange(code)}
                                className={`flex items-center justify-between gap-3 rounded-xl border p-3.5 text-left transition-colors disabled:opacity-60 ${
                                    isSelected
                                        ? 'border-[#FFD147] bg-[#FFD1471A]'
                                        : 'border-slr-navy-border bg-white/2 hover:bg-white/5'
                                }`}>
                                <span className='flex items-center gap-3'>
                                    {meta.badgeIcon && (
                                        <Image
                                            src={meta.badgeIcon}
                                            alt=''
                                            width={56}
                                            height={56}
                                            className='size-8 shrink-0 object-contain'
                                        />
                                    )}
                                    <span>
                                        <span className='block text-sm font-medium text-white'>
                                            {planLabel(code)}
                                        </span>
                                        <span className='text-slr-muted text-xs'>
                                            {code.startsWith('R') ? 'Weekly draws' : 'VIP draws'}
                                        </span>
                                    </span>
                                </span>
                                <span className='text-sm font-semibold whitespace-nowrap text-[#FFDC75]'>
                                    {busyReset && isSelected ? (
                                        <Loader2Icon className='h-4 w-4 animate-spin' />
                                    ) : (
                                        `${priceLabel(pricing, code)} / 28 days`
                                    )}
                                </span>
                            </button>
                        );
                    })}
                </div>

                <Button
                    type='button'
                    variant='outline'
                    disabled={busyReset}
                    onClick={() => setPicking(false)}
                    className='h-11 rounded-xl border border-white/10 bg-white/5 font-semibold text-white hover:bg-white/10 hover:text-white'>
                    Back to order review
                </Button>

                <AlertDialog
                    open={pendingTierChange !== null}
                    onOpenChange={busyReset ? undefined : (open) => !open && setPendingTierChange(null)}>
                    <AlertDialogContent className='rounded-2xl border border-[#A0B4D259] bg-[linear-gradient(154.36deg,#141820_0.82%,#1E2530_49.73%,#141820_98.65%)] p-6 text-white shadow-[0px_0px_20px_0px_#776D6D26] sm:max-w-md'>
                        <AlertDialogHeader className='text-left'>
                            <AlertDialogTitle className='font-bebas-neue text-2xl tracking-wider text-white uppercase'>
                                Change Plan &amp; Reset Cart
                            </AlertDialogTitle>
                            <AlertDialogDescription className='text-slr-muted text-sm' asChild>
                                <div className='space-y-3 pt-1'>
                                    <p className='text-slr-muted text-xs leading-relaxed'>
                                        Changing your membership plan to{' '}
                                        <span className='font-semibold text-white'>
                                            {pendingTierChange ? planLabel(pendingTierChange) : ''}
                                        </span>{' '}
                                        will reset your order details.
                                    </p>

                                    <div className='rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs leading-relaxed text-amber-200'>
                                        <ul className='space-y-1.5 font-medium'>
                                            {hasSpinPrize && spinPrize ? (
                                                <li>
                                                    • Your Spin Wheel discount (-$
                                                    {Math.min(spinPrize.discountAmount, subtotal).toFixed(2)}) will be permanently forfeited and cannot be re-spun or reclaimed.
                                                </li>
                                            ) : null}
                                            {appliedCoupon ? (
                                                <li>• Your active promo code ({appliedCoupon.code}) will be removed.</li>
                                            ) : null}
                                            {pendingTierChange && isStandardSubTier(pendingTierChange) && hasBeny ? (
                                                <li>• The BENY Add-on is not available for Standard plan and will be removed.</li>
                                            ) : null}
                                            <li>• Changing tiers does not grant another spin on the wheel.</li>
                                        </ul>
                                    </div>

                                    <p className='text-slr-dim text-xs'>
                                        Are you sure you want to proceed and change your plan?
                                    </p>
                                </div>
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter className='mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3'>
                            <Button
                                type='button'
                                variant='ghost'
                                disabled={busyReset}
                                onClick={() => setPendingTierChange(null)}
                                className='h-11 rounded-xl px-5 text-xs font-semibold uppercase tracking-wider text-slr-muted transition-colors hover:bg-white/5 hover:text-white sm:text-sm'>
                                Cancel
                            </Button>
                            <Button
                                type='button'
                                disabled={busyReset}
                                onClick={executeTierChange}
                                style={goldButtonStyle}
                                className='h-11 min-w-[170px] rounded-xl font-bold uppercase shadow-md transition-opacity hover:opacity-90 disabled:opacity-70 text-[#1a1408]'>
                                {busyReset ? (
                                    <>
                                        <Loader2Icon className='animate-spin' /> Switching…
                                    </>
                                ) : (
                                    'Confirm & Change Plan'
                                )}
                            </Button>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </div>
        );
    }

    return (
        <div className='flex flex-col gap-6'>
            {/* Dismissible alert banners */}
            {showSessionExpiredAlert ? (
                <div className='flex items-start justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200'>
                    <div className='flex items-start gap-2.5'>
                        <AlertCircle className='mt-0.5 size-4 shrink-0 text-amber-300' />
                        <p>
                            Your previous checkout link has expired. You can review your details and
                            start a fresh checkout below.
                        </p>
                    </div>
                    <button
                        type='button'
                        onClick={() => setShowSessionExpiredAlert(false)}
                        className='text-amber-300/80 hover:text-amber-200'>
                        <X className='size-3.5' />
                    </button>
                </div>
            ) : null}

            {showPromoExpiredAlert ? (
                <div className='flex items-start justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200'>
                    <div className='flex items-start gap-2.5'>
                        <AlertCircle className='mt-0.5 size-4 shrink-0 text-amber-300' />
                        <p>Your previous promo code has expired and was removed.</p>
                    </div>
                    <button
                        type='button'
                        onClick={() => setShowPromoExpiredAlert(false)}
                        className='text-amber-300/80 hover:text-amber-200'>
                        <X className='size-3.5' />
                    </button>
                </div>
            ) : null}

            {showSpinExpiredAlert ? (
                <div className='flex items-start justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-200'>
                    <div className='flex items-start gap-2.5'>
                        <AlertCircle className='mt-0.5 size-4 shrink-0 text-amber-300' />
                        <p>Your spin discount has expired.</p>
                    </div>
                    <button
                        type='button'
                        onClick={() => setShowSpinExpiredAlert(false)}
                        className='text-amber-300/80 hover:text-amber-200'>
                        <X className='size-3.5' />
                    </button>
                </div>
            ) : null}

            {/* Selected plan badge + Change plan button */}
            <div className='border-slr-navy-border flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white/2 p-4'>
                <div className='flex items-center gap-3'>
                    {selectedMeta.badgeIcon && (
                        <Image
                            src={selectedMeta.badgeIcon}
                            alt=''
                            width={96}
                            height={96}
                            className='size-10 shrink-0 object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.5)]'
                        />
                    )}
                    <div>
                        <p className='text-slr-dim text-[10px] font-semibold tracking-widest uppercase'>
                            Selected plan
                        </p>
                        <p className='mt-0.5 text-sm font-medium text-white'>
                            {planLabel(selectedSubTier)} — ${subtotal.toFixed(2)} / 28 days
                        </p>
                    </div>
                </div>
                <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={redirecting || busyReset}
                    onClick={() => setPicking(true)}
                    className='rounded-lg border-white/10 bg-white/5 text-xs font-semibold text-white hover:bg-white/10 hover:text-white'>
                    Change plan
                </Button>
            </div>

            {/* BENY add-on section */}
            {canAddBeny ? (
                <div className='flex items-start gap-3 rounded-xl border border-[#D4AF3759] bg-[#D4AF371A]/5 p-4 transition-all hover:bg-[#D4AF371A]/10'>
                    <Checkbox
                        id='beny'
                        checked={hasBeny}
                        disabled={redirecting}
                        onCheckedChange={(checked) => handleToggleBeny(Boolean(checked))}
                        className='mt-1 border-[#FFD147] data-[state=checked]:bg-[#FFD147] data-[state=checked]:text-[#131619]'
                    />
                    <div className='grid gap-1.5 leading-none'>
                        <label
                            htmlFor='beny'
                            className='cursor-pointer text-sm font-bold tracking-wide text-white uppercase select-none'>
                            Add BENY Add-on — +${BENY_PRICE.toFixed(2)}/month
                        </label>
                        <p className='text-slr-muted text-xs leading-relaxed'>
                            Access premium brand discounts through the BENY app. Billed directly to
                            your card on Stripe (+${BENY_PRICE.toFixed(2)}/mo). Access requires
                            manual activation and confirmation by an SLR Admin after registration.
                        </p>

                        {hasBeny ? (
                            <div className='mt-2'>
                                <label
                                    htmlFor='beny-phone'
                                    className='text-slr-muted text-xs font-semibold'>
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
                                        This is the number our admin uses to invite you on BENY.
                                    </p>
                                )}
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}

            {/* Promo code & Spin discount section */}
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
                                {couponBadgeLabel(
                                    appliedCoupon,
                                    isBenyCoupon ? BENY_PRICE : subtotal
                                )}
                            </span>
                            <span className='text-emerald-200/60 text-xs'>
                                ({isBenyCoupon ? 'BENY' : 'Membership'})
                            </span>
                        </div>
                        <button
                            type='button'
                            onClick={handleRemoveCoupon}
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

            {/* Order summary card */}
            <div className='rounded-2xl border border-[#A0B4D259] bg-[linear-gradient(154.36deg,#141820_0.82%,#1E2530_49.73%,#141820_98.65%)] p-6 shadow-[0px_0px_20px_0px_#776D6D26] md:p-8'>
                <div className='space-y-4'>
                    <SummaryRow
                        label={planLabel(selectedSubTier)}
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
                            <p className='font-bebas-neue text-xl tracking-wider text-white uppercase'>
                                Due today
                            </p>
                            <p className='text-slr-muted text-xs'>
                                {willAddBeny
                                    ? `Then $${subtotal.toFixed(2)} every 4 weeks (Membership) & $${BENY_PRICE.toFixed(2)}/month (BENY) from your next billing date.`
                                    : `Then $${subtotal.toFixed(2)} every 4 weeks from your next billing date.`}
                            </p>
                        </div>
                        <p className='font-bebas-neue text-3xl font-extrabold text-[#FFDC75]'>
                            ${total.toFixed(2)}
                        </p>
                    </div>
                </div>
            </div>

            {safeHoursLocked ? <SafeHoursNotice /> : null}

            {/* Action button */}
            <Button
                type='button'
                onClick={handleProceed}
                disabled={redirecting || safeHoursLocked || busyReset}
                style={goldButtonStyle}
                className='h-12 w-full rounded-xl text-base font-bold uppercase shadow-md transition-opacity hover:opacity-90 disabled:opacity-70 text-[#1a1408]'>
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
                            disabled={redirecting || safeHoursLocked || busyReset}
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
            <p className={muted ? 'text-slr-muted text-sm' : 'text-sm font-medium text-white'}>
                {label}
            </p>
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

export default CompletePaymentClient;
