"use client";

import attentionStyles from './review-attention.module.css';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { MenuRoot, MenuTrigger, MenuTransition, MenuItemsSurface, MenuActionItem } from '@/components/ui/menu';

export interface ReviewMenuAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  description?: string;
  hidden?: boolean;
  danger?: boolean;
  className?: string;
  attention?: boolean;
}
export interface ReviewMenuSection { title: string; actions: ReviewMenuAction[] }

export function ReviewMenu({ label, sections, icon, attention = false }: { label: string; sections: ReviewMenuSection[]; icon?: ReactNode; attention?: boolean }) {
  return <MenuRoot>
    <MenuTrigger as={Button} variant="outline" className={`min-h-11 md:min-h-8 ${attention ? attentionStyles.attention : ''}`} data-pronunciation-attention={attention || undefined} aria-label={label} title={attention ? `${label}: pronunciation issues need review` : label}>
      {icon || <><span className="hidden md:inline">{label} <span aria-hidden="true" className="ml-1">▾</span></span><span className="md:hidden" aria-hidden="true">⋯</span></>}
      {attention && <span className="ml-1 rounded bg-warning-wash px-1 text-warning" aria-hidden="true">⚠</span>}
    </MenuTrigger>
    <MenuTransition>
      <MenuItemsSurface anchor="bottom end" portal className="z-[60] w-64 max-h-[min(32rem,80dvh)] overflow-y-auto [--anchor-gap:6px]" aria-label={label}>
        {sections.map((section) => section.actions.some(a => !a.hidden) && <div key={section.title} className="border-b border-line-soft last:border-0">
          <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-soft">{section.title}</p>
          {section.actions.filter(a => !a.hidden).map(action => <MenuActionItem key={action.label} onClick={action.onClick} disabled={action.disabled} tone={action.danger ? 'danger' : 'default'} className={`min-h-11 md:min-h-8 ${action.className || ''} ${action.attention ? attentionStyles.attention : ''}`} data-pronunciation-attention={action.attention || undefined}>
            <span>{action.attention && <span aria-hidden="true" className="mr-1 text-warning">⚠</span>}{action.label}{action.description && <span className="block text-[11px] font-normal">{action.description}</span>}</span>
          </MenuActionItem>)}
        </div>)}
      </MenuItemsSurface>
    </MenuTransition>
  </MenuRoot>;
}
