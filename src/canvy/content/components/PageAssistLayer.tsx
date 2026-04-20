import { useEffect, useMemo, useState } from 'react';
import type { PageAssistPayload, PageAssistTarget } from '../../shared/types';

interface PageAssistLayerProps {
  payload: PageAssistPayload;
  onDismiss: () => void;
  onOpenSidebar: () => void;
}

function buildCardBody(payload: PageAssistPayload, _target: PageAssistTarget, index: number) {
  if (index === 0) {
    return payload.explanation;
  }

  if (index === 1 && payload.outline.length) {
    return payload.outline.slice(0, 3).join(' | ');
  }

  if (payload.reviewAreas.length) {
    return payload.reviewAreas.slice(0, 2).join(' ');
  }

  return payload.summary;
}

function measureAnchors(targets: PageAssistTarget[]) {
  return targets.reduce<Record<string, { top: number; left: number }>>((positions, target) => {
    if (!target.stablePlacement || !target.anchorId) {
      return positions;
    }

    const anchor = document.querySelector<HTMLElement>(`[data-canvy-assist-id="${target.anchorId}"]`);
    if (!anchor) {
      return positions;
    }

    const rect = anchor.getBoundingClientRect();
    const preferredLeft = rect.right + 18;
    const cardWidth = 296;
    positions[target.id] = {
      top: Math.max(18, Math.min(rect.top, window.innerHeight - 220)),
      left:
        preferredLeft + cardWidth < window.innerWidth - 18
          ? preferredLeft
          : Math.max(18, rect.left - cardWidth - 18)
    };
    return positions;
  }, {});
}

export function PageAssistLayer({ payload, onDismiss, onOpenSidebar }: PageAssistLayerProps) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [positions, setPositions] = useState<Record<string, { top: number; left: number }>>({});

  const visibleTargets = useMemo(
    () => payload.targets.filter((target) => !dismissed.includes(target.id)).slice(0, 3),
    [dismissed, payload.targets]
  );

  useEffect(() => {
    const updatePositions = () => setPositions(measureAnchors(visibleTargets));
    updatePositions();
    window.addEventListener('scroll', updatePositions, true);
    window.addEventListener('resize', updatePositions);
    return () => {
      window.removeEventListener('scroll', updatePositions, true);
      window.removeEventListener('resize', updatePositions);
    };
  }, [visibleTargets]);

  if (!visibleTargets.length) {
    return null;
  }

  return (
    <div className="canvy-assist-layer" aria-label="Mako IQ on-page assist">
      {visibleTargets.map((target, index) => {
        const anchored = target.stablePlacement && positions[target.id];
        return (
          <section
            key={target.id}
            className={`canvy-assist-card ${anchored ? 'canvy-assist-card-anchored' : 'canvy-assist-card-docked'}`}
            style={
              anchored
                ? {
                    top: `${positions[target.id].top}px`,
                    left: `${positions[target.id].left}px`
                  }
                : {
                    right: '18px',
                    bottom: `${18 + index * 188}px`
                  }
            }
          >
            <div className="canvy-assist-head">
              <div>
                <div className="canvy-eyebrow">Mako IQ</div>
                <h3>{target.title}</h3>
              </div>
              <button className="canvy-close" type="button" onClick={() => setDismissed((current) => [...current, target.id])}>
                x
              </button>
            </div>
            <p className="canvy-assist-snippet">{target.snippet}</p>
            <div className="canvy-assist-body">{buildCardBody(payload, target, index)}</div>
            <div className="canvy-action-row">
              <button className="canvy-secondary" type="button" onClick={onOpenSidebar}>
                Open Workspace
              </button>
              <button className="canvy-secondary" type="button" onClick={onDismiss}>
                Hide cards
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
