import { formatMoney, type MoneyJson } from '../lib/money';

export function Price({
  price,
  compareAt,
  tag,
  from = false,
  size = 'md',
}: {
  price: MoneyJson;
  compareAt?: MoneyJson | null;
  tag: string;
  from?: boolean;
  size?: 'md' | 'lg';
}) {
  const onSale = compareAt && BigInt(compareAt.amount) > BigInt(price.amount);
  return (
    <span className={`price price--${size}`}>
      {from ? <span className="price__from">From </span> : null}
      <span className={onSale ? 'price__now price__now--sale' : 'price__now'}>
        {formatMoney(price, tag)}
      </span>
      {onSale ? (
        <>
          <span className="visually-hidden"> was </span>
          <s className="price__was">{formatMoney(compareAt, tag)}</s>
        </>
      ) : null}
    </span>
  );
}
