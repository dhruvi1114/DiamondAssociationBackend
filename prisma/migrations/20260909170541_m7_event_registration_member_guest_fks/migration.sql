-- CreateIndex
CREATE INDEX "EventRegistrations_guest_registrant_id_idx" ON "EventRegistrations"("guest_registrant_id");

-- AddForeignKey
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "Members"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRegistrations" ADD CONSTRAINT "EventRegistrations_guest_registrant_id_fkey" FOREIGN KEY ("guest_registrant_id") REFERENCES "GuestRegistrants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
