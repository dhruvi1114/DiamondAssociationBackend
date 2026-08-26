import type { PrismaClient } from '@prisma/client';

/**
 * Geography for the registration form's cascading selects.
 *
 * Idempotent: every write is an upsert on the natural key, so running the seed
 * twice is a no-op rather than a duplicate. Re-running after adding a city to the
 * list below adds only that city.
 *
 * Coverage is deliberate, not lazy (spec OQ-R4): Gujarat and Maharashtra carry the
 * membership and are listed in full; every other state carries its principal cities.
 * A missing city is a data row an administrator adds, not a code change.
 */
const STATES: ReadonlyArray<{ code: string; name: string; cities: readonly string[] }> = [
  {
    code: 'GJ',
    name: 'Gujarat',
    cities: [
      'Ahmedabad', 'Amreli', 'Anand', 'Aravalli', 'Banaskantha', 'Bharuch', 'Bhavnagar',
      'Botad', 'Chhota Udepur', 'Dahod', 'Dang', 'Devbhoomi Dwarka', 'Gandhinagar',
      'Gir Somnath', 'Jamnagar', 'Junagadh', 'Kheda', 'Kutch', 'Mahisagar', 'Mehsana',
      'Morbi', 'Narmada', 'Navsari', 'Panchmahal', 'Patan', 'Porbandar', 'Rajkot',
      'Sabarkantha', 'Surat', 'Surendranagar', 'Tapi', 'Vadodara', 'Valsad',
    ],
  },
  {
    code: 'MH',
    name: 'Maharashtra',
    cities: [
      'Ahmednagar', 'Akola', 'Amravati', 'Aurangabad', 'Beed', 'Bhandara', 'Buldhana',
      'Chandrapur', 'Dhule', 'Gadchiroli', 'Gondia', 'Hingoli', 'Jalgaon', 'Jalna',
      'Kolhapur', 'Latur', 'Mumbai', 'Nagpur', 'Nanded', 'Nandurbar', 'Nashik',
      'Osmanabad', 'Palghar', 'Parbhani', 'Pune', 'Raigad', 'Ratnagiri', 'Sangli',
      'Satara', 'Sindhudurg', 'Solapur', 'Thane', 'Wardha', 'Washim', 'Yavatmal',
    ],
  },
  { code: 'AP', name: 'Andhra Pradesh', cities: ['Visakhapatnam', 'Vijayawada', 'Guntur', 'Tirupati', 'Nellore'] },
  { code: 'AR', name: 'Arunachal Pradesh', cities: ['Itanagar', 'Naharlagun'] },
  { code: 'AS', name: 'Assam', cities: ['Guwahati', 'Silchar', 'Dibrugarh', 'Jorhat'] },
  { code: 'BR', name: 'Bihar', cities: ['Patna', 'Gaya', 'Bhagalpur', 'Muzaffarpur'] },
  { code: 'CG', name: 'Chhattisgarh', cities: ['Raipur', 'Bhilai', 'Bilaspur', 'Korba'] },
  { code: 'DL', name: 'Delhi', cities: ['New Delhi', 'North Delhi', 'South Delhi', 'East Delhi', 'West Delhi'] },
  { code: 'GA', name: 'Goa', cities: ['Panaji', 'Margao', 'Vasco da Gama'] },
  { code: 'HR', name: 'Haryana', cities: ['Gurugram', 'Faridabad', 'Panipat', 'Ambala', 'Hisar'] },
  { code: 'HP', name: 'Himachal Pradesh', cities: ['Shimla', 'Solan', 'Dharamshala', 'Mandi'] },
  { code: 'JH', name: 'Jharkhand', cities: ['Ranchi', 'Jamshedpur', 'Dhanbad', 'Bokaro'] },
  { code: 'JK', name: 'Jammu and Kashmir', cities: ['Srinagar', 'Jammu'] },
  { code: 'KA', name: 'Karnataka', cities: ['Bengaluru', 'Mysuru', 'Hubballi', 'Mangaluru', 'Belagavi'] },
  { code: 'KL', name: 'Kerala', cities: ['Thiruvananthapuram', 'Kochi', 'Kozhikode', 'Thrissur', 'Kollam'] },
  { code: 'LA', name: 'Ladakh', cities: ['Leh', 'Kargil'] },
  { code: 'MP', name: 'Madhya Pradesh', cities: ['Bhopal', 'Indore', 'Jabalpur', 'Gwalior', 'Ujjain'] },
  { code: 'MN', name: 'Manipur', cities: ['Imphal'] },
  { code: 'ML', name: 'Meghalaya', cities: ['Shillong', 'Tura'] },
  { code: 'MZ', name: 'Mizoram', cities: ['Aizawl'] },
  { code: 'NL', name: 'Nagaland', cities: ['Kohima', 'Dimapur'] },
  { code: 'OD', name: 'Odisha', cities: ['Bhubaneswar', 'Cuttack', 'Rourkela', 'Puri'] },
  { code: 'PB', name: 'Punjab', cities: ['Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala', 'Mohali'] },
  { code: 'PY', name: 'Puducherry', cities: ['Puducherry', 'Karaikal'] },
  { code: 'RJ', name: 'Rajasthan', cities: ['Jaipur', 'Jodhpur', 'Udaipur', 'Kota', 'Bikaner', 'Ajmer'] },
  { code: 'SK', name: 'Sikkim', cities: ['Gangtok'] },
  { code: 'TN', name: 'Tamil Nadu', cities: ['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem'] },
  { code: 'TS', name: 'Telangana', cities: ['Hyderabad', 'Warangal', 'Nizamabad', 'Karimnagar'] },
  { code: 'TR', name: 'Tripura', cities: ['Agartala'] },
  { code: 'UP', name: 'Uttar Pradesh', cities: ['Lucknow', 'Kanpur', 'Varanasi', 'Agra', 'Noida', 'Ghaziabad', 'Meerut'] },
  { code: 'UK', name: 'Uttarakhand', cities: ['Dehradun', 'Haridwar', 'Roorkee', 'Haldwani'] },
  { code: 'WB', name: 'West Bengal', cities: ['Kolkata', 'Howrah', 'Durgapur', 'Asansol', 'Siliguri'] },
  { code: 'AN', name: 'Andaman and Nicobar Islands', cities: ['Port Blair'] },
  { code: 'CH', name: 'Chandigarh', cities: ['Chandigarh'] },
  { code: 'DN', name: 'Dadra and Nagar Haveli and Daman and Diu', cities: ['Silvassa', 'Daman', 'Diu'] },
  { code: 'LD', name: 'Lakshadweep', cities: ['Kavaratti'] },
];

export const seedLocations = async (
  db: PrismaClient,
): Promise<{ countries: number; states: number; cities: number }> => {
  const india = await db.country.upsert({
    where: { iso_code: 'IN' },
    update: { name: 'India', display_order: 1 },
    create: { iso_code: 'IN', name: 'India', display_order: 1 },
  });

  for (const state of STATES) {
    const row = await db.state.upsert({
      where: { country_id_code: { country_id: india.id, code: state.code } },
      update: { name: state.name },
      create: { country_id: india.id, code: state.code, name: state.name },
    });

    for (const city of state.cities) {
      await db.city.upsert({
        where: { state_id_name: { state_id: row.id, name: city } },
        update: {},
        create: { state_id: row.id, name: city },
      });
    }
  }

  const cities = STATES.reduce((total, state) => total + state.cities.length, 0);

  return {
    countries: 1,
    states: STATES.length,
    cities,
  };
};
