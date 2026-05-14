import Cookies from 'js-cookie';

export type AuditAction = 
    | 'CART_ITEM_REMOVE' 
    | 'CART_CLEAR' 
    | 'SALE_CANCEL' 
    | 'PRICE_GUARD_TRIGGER'
    | 'AUTH_BYPASS_USED';

export async function registerAuditLog(action: AuditAction, module: string, details: string, isCritical: boolean = false) {
    try {
        const token = Cookies.get('org-pos-token');
        if (!token) return;

        const payload = {
            action,
            module,
            details,
            is_critical: isCritical,
            ip_address: '127.0.0.1', // El backend suele capturar esto, pero enviamos un placeholder
            created_at: new Date().toISOString()
        };

        // Intentamos enviar al backend
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/admin/audit-logs/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            // Si el backend no tiene este endpoint aún, guardamos en localStorage como respaldo
            const localLogs = JSON.parse(localStorage.getItem('pos_security_backups') || '[]');
            localLogs.push({ ...payload, sync_pending: true });
            localStorage.setItem('pos_security_backups', JSON.stringify(localLogs.slice(-100))); // Guardar últimos 100
        }
    } catch (error) {
        console.error("Audit log failed:", error);
    }
}
