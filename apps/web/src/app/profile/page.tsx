"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, UserRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button, Empty, Field, PageHeader, SectionTitle, inputClass } from "@/components/bits";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { api } from "@/lib/api";
import { useMe } from "@/lib/session";
import { useUi } from "@/lib/ui";

interface Profile { name: string; username: string | null; bio: string | null; xHandle: string | null; avatarUrl: string | null }

const BIO_MAX = 160;

/**
 * Shrinks a picture to a 256-pixel square in the browser, cropped from the middle, so what is uploaded is small and
 * every avatar is the same shape. GIFs and anything else become a still JPEG.
 */
async function squareAvatar(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("That file is not a picture"));
      img.src = url;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) throw new Error("That picture is empty");
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    return canvas.toDataURL("image/jpeg", 0.86);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function ProfilePage() {
  const me = useMe();
  const client = useQueryClient();
  const toast = useUi((s) => s.toast);
  const setConnectOpen = useUi((s) => s.setConnectOpen);
  const query = useQuery({ queryKey: ["profile"], enabled: !!me, queryFn: () => api<Profile>("/profile") });
  const [form, setForm] = useState({ username: "", bio: "", xHandle: "" });
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (query.data) setForm({ username: query.data.username ?? "", bio: query.data.bio ?? "", xHandle: query.data.xHandle ?? "" });
  }, [query.data]);

  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["profile"] });
    void client.invalidateQueries({ queryKey: ["me"] });
    void client.invalidateQueries({ queryKey: ["leaderboard"] });
  };

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, string> = { bio: form.bio, xHandle: form.xHandle };
      if (form.username.trim() !== (query.data?.username ?? "")) body.username = form.username.trim();
      return api<Profile>("/profile", { method: "PATCH", body });
    },
    onSuccess: async () => {
      await refresh();
      toast({ tone: "ok", title: "Profile saved" });
    },
    onError: (error) => toast({ tone: "bad", title: (error as Error).message }),
  });

  const upload = useMutation({
    mutationFn: async (file: File) => api<{ avatarUrl: string }>("/profile/avatar", { method: "PUT", body: { image: await squareAvatar(file) } }),
    onSuccess: async () => {
      await refresh();
      toast({ tone: "ok", title: "Picture updated" });
    },
    onError: (error) => toast({ tone: "bad", title: (error as Error).message }),
  });

  const remove = useMutation({
    mutationFn: () => api("/profile/avatar", { method: "DELETE" }),
    onSuccess: refresh,
    onError: (error) => toast({ tone: "bad", title: (error as Error).message }),
  });

  if (!me) {
    return (
      <Empty title="Connect to set up your profile" icon={<UserRound size={22} aria-hidden="true" />}>
        <Button tone="primary" onClick={() => setConnectOpen(true)}>Connect</Button>
      </Empty>
    );
  }
  const profile = query.data;
  const name = form.username || profile?.name || me.handle;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-2 px-2 pb-2 sm:px-3">
        <PageHeader
          title="Your profile"
          subtitle="This is what people see on the leaderboard and your profile page. Your wallet address is never shown."
          right={profile?.username ? <Link href={`/u/${profile.username}`} className="text-[13.5px] font-semibold text-gold hover:underline">View your page</Link> : null}
        />
        <section className="slab">
          <SectionTitle>Picture</SectionTitle>
          <div className="flex flex-wrap items-center gap-4 px-4 pb-4">
            <ProfileAvatar name={name} src={profile?.avatarUrl} size={88} />
            <div className="flex flex-wrap gap-2">
              <input
                ref={picker}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) upload.mutate(file);
                }}
              />
              <Button onClick={() => picker.current?.click()} disabled={upload.isPending}>
                <ImagePlus size={15} aria-hidden="true" /> {upload.isPending ? "Uploading" : profile?.avatarUrl ? "Change picture" : "Upload picture"}
              </Button>
              {profile?.avatarUrl ? <Button tone="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>Remove</Button> : null}
            </div>
          </div>
        </section>
        <form
          className="slab"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <SectionTitle right={<Button type="submit" tone="primary" className="h-9" disabled={save.isPending || !form.username.trim()}>Save</Button>}>Details</SectionTitle>
          <div className="flex flex-col gap-3 px-4 pb-4">
            <Field label="Username" hint="3 to 20 letters, numbers or underscores. Unique.">
              <div className="flex items-center gap-1.5">
                <span className="text-faint">@</span>
                <input
                  className={inputClass}
                  value={form.username}
                  maxLength={20}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="pick_a_name"
                  onChange={(e) => setForm((f) => ({ ...f, username: e.target.value.replace(/[^A-Za-z0-9_]/g, "") }))}
                />
              </div>
            </Field>
            <Field label={`Bio · ${form.bio.length}/${BIO_MAX}`}>
              <textarea
                className={`${inputClass} h-24 resize-none py-2`}
                value={form.bio}
                maxLength={BIO_MAX}
                placeholder="What you collect, your best pull, anything"
                onChange={(e) => setForm((f) => ({ ...f, bio: e.target.value }))}
              />
            </Field>
            <Field label="X handle" hint="Optional. Shown as a link on your page.">
              <div className="flex items-center gap-1.5">
                <span className="text-faint">@</span>
                <input
                  className={inputClass}
                  value={form.xHandle}
                  maxLength={15}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="handle"
                  onChange={(e) => setForm((f) => ({ ...f, xHandle: e.target.value.replace(/^@/, "") }))}
                />
              </div>
            </Field>
          </div>
        </form>
      </div>
    </div>
  );
}
