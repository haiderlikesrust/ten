export default function BlockedPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="pixel text-[16px] uppercase">Not available here</h1>
      <p className="max-w-sm text-mute">This service is not offered in your region.</p>
    </div>
  );
}
