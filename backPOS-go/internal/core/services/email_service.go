package services

import (
	"fmt"
	"net/smtp"
	"os"
)

type EmailService struct {
	host      string
	port      string
	user      string
	pass      string
	fromEmail string
	fromName  string
}

func NewEmailService() *EmailService {
	return &EmailService{
		host:      os.Getenv("SMTP_HOST"),
		port:      os.Getenv("SMTP_PORT"),
		user:      os.Getenv("SMTP_USER"),
		pass:      os.Getenv("SMTP_PASS"),
		fromEmail: os.Getenv("SMTP_FROM_EMAIL"),
		fromName:  os.Getenv("SMTP_FROM_NAME"),
	}
}

func (s *EmailService) SendResetPasswordEmail(to, name, resetLink string) error {
	subject := "Restablecimiento de Contraseña - Surtifamiliar"
	
	body := fmt.Sprintf(`
		<!DOCTYPE html>
		<html>
		<head>
			<style>
				body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; }
				.container { max-width: 600px; margin: 20px auto; padding: 20px; border: 1px solid #eee; border-radius: 10px; }
				.header { background: #10b981; color: white; padding: 20px; text-align: center; border-radius: 10px 10px 0 0; }
				.content { padding: 30px; text-align: center; }
				.button { display: inline-block; padding: 15px 30px; background-color: #10b981; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; margin-top: 20px; }
				.footer { font-size: 12px; color: #888; text-align: center; margin-top: 30px; }
			</style>
		</head>
		<body>
			<div class="container">
				<div class="header">
					<h1>Surtifamiliar</h1>
				</div>
				<div class="content">
					<h2>Hola %s,</h2>
					<p>Has solicitado restablecer tu contraseña para acceder al sistema POS Surtifamiliar.</p>
					<p>Haz clic en el siguiente botón para crear una nueva contraseña. Este enlace expirará en 1 hora.</p>
					<a href="%s" class="button">Restablecer Contraseña</a>
					<p style="margin-top: 25px;">Si no solicitaste este cambio, puedes ignorar este correo de forma segura.</p>
				</div>
				<div class="footer">
					<p>&copy; 2026 Soporte Supermercado Surtifamiliar. Todos los derechos reservados.</p>
				</div>
			</div>
		</body>
		</html>
	`, name, resetLink)

	return s.sendHTMLEmail(to, subject, body)
}

func (s *EmailService) sendHTMLEmail(to, subject, body string) error {
	mime := "MIME-version: 1.0;\nContent-Type: text/html; charset=\"UTF-8\";\n\n"
	message := []byte(fmt.Sprintf("From: %s <%s>\r\nTo: %s\r\nSubject: %s\r\n%s%s", s.fromName, s.fromEmail, to, subject, mime, body))

	auth := smtp.PlainAuth("", s.user, s.pass, s.host)
	addr := fmt.Sprintf("%s:%s", s.host, s.port)

	return smtp.SendMail(addr, auth, s.fromEmail, []string{to}, message)
}
