import type { Address } from '../contracts';

export interface CheckoutConfig {
  /** Where the seller ships from (drives origin-sourced tax rules). */
  origin: Address;
  /** True in AU/NZ/UK/EU style storefronts where displayed prices already contain tax. */
  pricesIncludeTax: boolean;
  /** How long an unpaid order holds its stock before the sweeper cancels it. */
  paymentWindowMinutes: number;
}

export const defaultCheckoutConfig: CheckoutConfig = {
  origin: {
    line1: '1 Example St',
    city: 'Sydney',
    region: 'NSW',
    postalCode: '2000',
    country: 'AU',
  },
  pricesIncludeTax: true,
  paymentWindowMinutes: 30,
};
