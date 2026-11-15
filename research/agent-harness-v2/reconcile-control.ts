// Bounded stock reference reconciliation. Timing comes from the declared fault window, never the outcome.
export interface SaleReconciliation {
  seconds: number;
  visible: () => Promise<boolean>;
  mayResend: () => boolean;
  missing: () => Promise<boolean>;
  nonceUnchanged: () => Promise<boolean>;
  resend: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  reconciled: () => void;
}
export async function reconcileControlSale(
  o: SaleReconciliation,
): Promise<void> {
  const waitForEffect = async () => {
    for (let i = 0; i <= o.seconds; i++) {
      if (await o.visible()) {
        o.reconciled();
        return true;
      }
      if (i < o.seconds) await o.sleep(1000);
    }
    return false;
  };
  if (await waitForEffect()) return;
  if (o.mayResend() && (await o.missing()) && (await o.nonceUnchanged())) {
    await o.resend();
    if (await waitForEffect()) return;
  }
  throw new Error("Sale did not reconcile");
}
