$env:PGPASSWORD='123'
& 'C:\Program Files\PostgreSQL\17\bin\psql.exe' -U postgres -h localhost -d sistemapos -c 'SELECT name, dni, "currentCredit" FROM clients WHERE "currentCredit" > 0;'
