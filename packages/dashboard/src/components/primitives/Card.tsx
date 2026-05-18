import type { ReactNode } from 'react';

export interface ICardProps {
  title?: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
  big?: ReactNode;
  elevated?: boolean;
  className?: string;
}

export function Card({ title, hint, big, children, elevated, className }: ICardProps): JSX.Element {
  return (
    <div className={`card${elevated ? ' card--elevated' : ''}${className ? ' ' + className : ''}`}>
      {title != null ? <div className="card__title">{title}</div> : null}
      {big != null ? <div className="card__big">{big}</div> : null}
      {children}
      {hint != null ? <div className="card__hint">{hint}</div> : null}
    </div>
  );
}
