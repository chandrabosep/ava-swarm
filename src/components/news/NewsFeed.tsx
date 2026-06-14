import { NewsCard } from './NewsCard';
import { mockNews } from '@/lib/mock';

export function NewsFeed() {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold">News feed</h2>
        <span className="text-[11px] text-fg-subtle uppercase tracking-wider">
          mock · 5 items
        </span>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {mockNews.map((item) => (
          <NewsCard key={item.id} item={item} />
        ))}
      </div>
    </section>
  );
}
