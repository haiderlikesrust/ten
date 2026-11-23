import { GATEWAY } from "@/lib/api";

/** A user's picture, or the first letter of their name in the site's pixel type when they have none. */
export function ProfileAvatar({ name, src, size = 32 }: { name: string; src?: string | null; size?: number }) {
  return (
    <span className="px-box flex shrink-0 items-center justify-center overflow-hidden [--s:2px]" style={{ width: size, height: size }}>
      {src ? (
        <img src={GATEWAY + src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" />
      ) : (
        <span className="pixel uppercase leading-none text-bone" style={{ fontSize: Math.max(11, Math.round(size * 0.42)) }}>{name.slice(0, 1)}</span>
      )}
    </span>
  );
}
