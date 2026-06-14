import { Surface } from '@/components/common/Surface';
import { Badge } from '@/components/common/Badge';
import { formatRelative } from '@/lib/format';
import type { NewsItem } from '@/types';

interface NewsCardProps {
  item: NewsItem;
}

export function NewsCard({ item }: NewsCardProps) {
  return (
    <Surface
      variant="raised"
      className="p-4 hover:border-border-strong transition-colors"
    >
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer noopener"
        className="block"
      >
        <div className="flex items-center gap-2 text-[11px] text-fg-subtle">
          <span className="font-medium text-fg-muted">{item.source}</span>
          <span aria-hidden>·</span>
          <span>{formatRelative(item.publishedAt)}</span>
        </div>
        <h3 className="mt-1.5 font-medium leading-snug text-fg group-hover:text-accent">
          {item.title}
        </h3>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {item.tags.map((tag) => (
            <Badge key={tag} tone="neutral">
              {tag}
            </Badge>
          ))}
        </div>
      </a>
    </Surface>
  );
}
