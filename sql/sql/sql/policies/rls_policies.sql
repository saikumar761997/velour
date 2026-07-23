-- ============================================================
-- Velour — Row Level Security (RLS) Policies
-- Synced from production: July 23, 2026
--
-- All 25 tables have RLS enabled. Policies listed here are
-- SELECT-only for public/anon access — the website reads
-- these tables directly via the Supabase anon key. All write
-- operations go through security-definer Edge Functions
-- (dashboard-read, dashboard-write) which use the service
-- role key and bypass RLS entirely.
--
-- Tables WITHOUT public read policies (writes only via
-- service role): bookings, booking_services, customers,
-- email_logs, payments, payment_line_items, payroll_periods,
-- payroll_period_hours, payroll_period_totals, rate_limit_counters,
-- salon_settings, technician_compensation, technician_links,
-- technician_time_off, walkin_queue
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE booking_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_period_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_period_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limit_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE salon_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE salon_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE salons ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_category_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_compensation ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE technician_time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE technicians ENABLE ROW LEVEL SECURITY;
ALTER TABLE walkin_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_gallery_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_settings ENABLE ROW LEVEL SECURITY;

-- Public read policies (website needs these via anon key)
CREATE POLICY "public_read_salons" ON salons FOR SELECT USING (true);
CREATE POLICY "public_read_hours" ON salon_hours FOR SELECT USING (true);
CREATE POLICY "public_read_services" ON services FOR SELECT USING (true);
CREATE POLICY "public_read_technicians" ON technicians FOR SELECT USING (true);
CREATE POLICY "public_read_tech_services" ON technician_services FOR SELECT USING (true);
CREATE POLICY "public_read_technician_hours" ON technician_hours FOR SELECT USING (true);
CREATE POLICY "public_read_products" ON products FOR SELECT USING (true);

-- Website settings policies (scoped to authenticated + anon)
CREATE POLICY "public read website_settings" ON website_settings
  FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "public read website_gallery_images" ON website_gallery_images
  FOR SELECT TO authenticated, anon USING (true);
CREATE POLICY "public read service_category_images" ON service_category_images
  FOR SELECT TO authenticated, anon USING (true);
