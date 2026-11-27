// ============================================================================
// Fonction Edge Supabase : zp-invite
// Le gérant crée l'identifiant de connexion d'une personne depuis ZPtools et
// reçoit un jeton à usage unique. ZPtools en fait un lien que le gérant envoie
// lui-même (SMS, WhatsApp, email) : aucun serveur d'email n'est nécessaire.
// La personne ouvre le lien et choisit son mot de passe.
//
// Sécurité :
//  - l'appelant doit être connecté, actif et de rôle « Gérant » (table app_users) ;
//  - la clé service_role ne quitte jamais le serveur ;
//  - chaque invitation est tracée dans zp_audit_events ;
//  - le jeton n'est pas un lien Supabase direct : un aperçu de lien (WhatsApp,
//    antivirus) ne peut donc pas le consommer avant la personne.
//
// Déploiement : Supabase → Edge Functions → nom « zp-invite », « Verify JWT » activé.
// Aucun secret à ajouter (SUPABASE_URL, SUPABASE_ANON_KEY et
// SUPABASE_SERVICE_ROLE_KEY sont fournis par Supabase).
// ============================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ORIGINS = ["https://zptools.fr"];

function cors(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": origin && ORIGINS.includes(origin) ? origin : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const headers = { ...cors(req.headers.get("origin")), "Content-Type": "application/json", "Cache-Control": "no-store" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return reply(405, { error: "Méthode non autorisée." });
  try {
    const authorization = req.headers.get("authorization") || "";
    if (!authorization) return reply(401, { error: "Connexion requise." });

    // 1. Qui appelle ?
    const caller = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
    const who = await caller.auth.getUser();
    const me = who.data?.user;
    if (who.error || !me?.id) return reply(401, { error: "Session non vérifiée." });

    // 2. Est-ce un gérant actif ?
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const profile = await admin.from("app_users").select("email,role,actif").eq("auth_user_id", me.id).maybeSingle();
    if (profile.error) throw profile.error;
    if (!profile.data || profile.data.actif !== true || profile.data.role !== "Gérant") {
      return reply(403, { error: "Invitation réservée au gérant." });
    }

    // 3. Adresse à inviter
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return reply(400, { error: "Adresse email invalide." });

    // 4. Créer l'identifiant s'il n'existe pas encore (sans mot de passe : la personne le choisit)
    let created = false;
    const creation = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (creation.error) {
      const already = creation.error.status === 422 || /already|exists|registered/i.test(creation.error.message || "");
      if (!already) throw creation.error;
    } else created = true;

    // 5. Jeton à usage unique pour choisir le mot de passe
    const link = await admin.auth.admin.generateLink({ type: "recovery", email });
    const token = link.data?.properties?.hashed_token;
    if (link.error || !token) throw link.error || new Error("Jeton non généré.");

    await admin.from("zp_audit_events").insert({
      actor_email: profile.data.email, action: created ? "account_invited" : "account_link_renewed",
      entity: "app_users", entity_id: email, details: { created },
    });
    return reply(200, { token, created });
  } catch (e) {
    console.error("zp-invite", e);
    return reply(500, { error: "Invitation impossible. Réessaie ou vérifie le journal de la fonction." });
  }
});
