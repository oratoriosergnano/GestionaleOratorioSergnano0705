// @ts-nocheck
// supabase/functions/send-push/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"
import webpush from "https://esm.sh/web-push@3.6.6"
import { Resend } from "https://esm.sh/resend@3.4.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

interface PushPayload {
  titolo?: string;
  corpo?: string;
  url?: string;
  target_tipo: 'superadmin' | 'genitore' | 'all';
  target_ids?: string[];
}

Deno.serve(async (req: any) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    const resendApiKey = Deno.env.get('RESEND_API_KEY') || '';
    
    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Credenziali Supabase mancanti');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const resend = resendApiKey ? new Resend(resendApiKey) : null;

    const body: PushPayload = await req.json();
    const { titolo, corpo, url, target_tipo, target_ids } = body;

    // --- 1. Recupera destinatari ---
    let emailDestinatari: string[] = [];
    let pushQuery = supabase.from('push_subscriptions').select('*');

    if (target_tipo === 'superadmin') {
      const { data: admins } = await supabase.from('admins').select('email').eq('attivo', true);
      emailDestinatari = admins?.map(a => a.email).filter(Boolean) || [];
      pushQuery = pushQuery.eq('user_type', 'superadmin');
    } else if (target_tipo === 'email_diretta' && target_ids && target_ids.length > 0) {
      emailDestinatari = target_ids;
      // Per le email dirette non cerchiamo push_subscriptions (a meno che non vogliamo inviare push anche lì)
      pushQuery = pushQuery.in('user_id', target_ids);
    } else if (target_tipo === 'genitore' && target_ids && target_ids.length > 0) {
      // Cerca le email dei genitori corrispondenti ai target_ids (che possono essere codici accesso o ID utente)
      const { data: genitori } = await supabase
        .from('iscrizioni')
        .select('email_genitore')
        .or(`codice_accesso.in.(${target_ids.join(',')}),utente_id.in.(${target_ids.join(',')})`);
      
      emailDestinatari = genitori?.map(g => g.email_genitore).filter(Boolean) || [];
      pushQuery = pushQuery.in('user_id', target_ids);
    }

    // --- 2. Invia notifiche PUSH ---
    let pushInviate = 0;
    const { data: subs } = await pushQuery;
    
    if (subs && subs.length > 0) {
      const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY');
      const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY');
      const mailto = Deno.env.get('VAPID_MAILTO') || 'mailto:admin@oratoriosergnano.it';

      if (vapidPublicKey && vapidPrivateKey) {
        webpush.setVapidDetails(mailto, vapidPublicKey, vapidPrivateKey);
        const payload = JSON.stringify({
          title: titolo || 'Oratorio Sergnano',
          body: corpo || 'Nuova notifica',
          icon: '/logo-oratorio.png',
          data: { url: url || '/' }
        });

        const risultati = await Promise.all(subs.map(async (s: any) => {
          try {
            const sub = typeof s.subscription === 'string' ? JSON.parse(s.subscription) : s.subscription;
            await webpush.sendNotification(sub, payload);
            return true;
          } catch { return false; }
        }));
        pushInviate = risultati.filter(r => r).length;
      }
    }

    // --- 3. Invia MAIL (se abbiamo destinatari e Resend è configurato) ---
    let mailInviate = 0;
    if (resend && emailDestinatari.length > 0 && titolo && corpo) {
      try {
        await resend.emails.send({
          from: 'Oratorio Sergnano <noreply@oratoriosergnanoonline.it>',
          to: emailDestinatari,
          subject: titolo,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <h2 style="color: #E25B45;">${titolo}</h2>
              <p style="font-size: 16px; line-height: 1.6;">${corpo}</p>
              ${url ? `<p><a href="${url}" style="background: #E25B45; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">Vai al sito</a></p>` : ''}
              <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
              <p style="color: #888; font-size: 12px; text-align: center;">Oratorio di Sergnano</p>
            </div>
          `
        });
        mailInviate = emailDestinatari.length;
        console.log('Mail inviate con successo a:', emailDestinatari);
      } catch (errMail) {
        console.error('Errore invio mail:', errMail);
      }
    }

    return new Response(JSON.stringify({ 
      success: true, 
      push_inviati: pushInviate,
      mail_inviate: mailInviate 
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    console.error('Errore server:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500
    });
  }
})
