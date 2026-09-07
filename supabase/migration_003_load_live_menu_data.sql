-- ============================================================
-- Migration 003 — Load real Tap List + Wine & N/A data
-- Source: tmbvkusticlunsmqjfty.supabase.co (old MVP, being retired).
-- Replaces the placeholder seed beers with the real 15-item tap list
-- and populates wine_menu with the real 19-item wine/N/A list. IDs
-- are preserved verbatim from the old project.
--
-- Run this in the Supabase SQL Editor against the LIVE project
-- (opatyodqtfrytgosqxom), after migration_002.
-- ============================================================

alter table beers add column if not exists collab_partner text;

-- Clears the placeholder seed beers (and any free_pours pointing at
-- them — there should be none yet since check-in hasn't been used).
delete from free_pours;
delete from beers;

insert into beers (id, ref_id, name, style, description, category, abv, price, status, badges, collab_partner) values
  ('017bf196-6d74-472d-bcec-31effae9e307','33','Bronco Blonde','Blonde Ale','Smooth and easy-drinking with a touch of honey sweetness and a clean finish.','Light & Lager',5,6.5,'active','{}',null),
  ('52dcc935-6cb0-4a92-9dc9-f8601f772fc8','34','Howdyfest','Rye Lager','A Texas take on a classic lager with a spicy rye backbone and smooth malt body.','Light & Lager',6.2,6.5,'active','{}',null),
  ('b16e6e28-98d6-43b5-beae-616a27e20c77','35','Southern Drawl','Helles Lager','Soft malty and approachable — a Bavarian classic brewed for the Texas heat.','Light & Lager',5.5,6.5,'active','{back_again}',null),
  ('85f5736a-17c7-4c16-9fa0-d2efaf052b44','36','Orbit Sixx-T','Patersbier','The sessionable table beer of Belgian monks — golden gentle and quietly complex.','Light & Lager',5.8,6.5,'active','{}',null),
  ('58474929-778d-4ec7-bd8b-8dce4ffd9743','37','Purple Rain','Lavender & Chamomile Maibock','A smooth, golden Maibock with honeyed malt sweetness and delicate notes of lavender and chamomile (contains lavender extract made in a facility that processes nuts).','Light & Lager',6.5,7,'active','{}',null),
  ('4cdb3ea9-b56c-49b7-9da2-30ba9f0d0c3f','38','Bonfire','Amber Ale','Rich caramel malt with a gentle hop balance and a warm toasty finish.','Ales & IPAs',5,6.5,'active','{}',null),
  ('c20e2897-a7f8-4373-9171-fb8f95613221','39','Vista IPA','IPA','Bold citrus and pine hop character with a clean bitter finish that opens up the view.','Ales & IPAs',6.2,7.5,'active','{}',null),
  ('a107f1e1-8111-4d20-8ffa-aa3671be4898','40','3rd And Totally Tubular','Piña Colada Ale','This all that and a bag of chips—loaded with pineapple, coconut, and enough tropical nostalgia to make your inner 90s kid do the Macarena.','Ales & IPAs',6,7.5,'active','{lactose}',null),
  ('10af934d-d784-47f5-ab6b-b6d2af3b8f43','41','All Burn','Rauchbier','German smoked malt brings the campfire to the glass — savory deep and unforgettable.','Ales & IPAs',5.2,7.5,'active','{back_again}',null),
  ('1a39c80b-10c9-4f75-97a7-91f3348461f2','42','MMM Berliner','Berliner Weisse','Tart refreshing and light — a classic German wheat ale with bright lactic acidity.','Ales & IPAs',3.8,6.5,'active','{}',null),
  ('3744980f-d035-4c72-8fe0-daa9d681d989','43','Brazos Abbey','Belgian Dubbel','Dark fruit brown sugar and Belgian yeast spice in a rich abbey-style ale.','Strong & Specialty',6.5,7.5,'active','{}',null),
  ('21c01ef4-13e5-437c-886f-26904dbd2d1e','44','Double Quad Dare','Belgian Quad','A bold warming strong ale with dried fruit caramel depth and monastic complexity.','Strong & Specialty',8.5,7.5,'active','{}',null),
  ('801244d5-0f3f-4728-baee-396a06eeff4e','45','Mintal Vacation','Mint Milk Chocolate Stout','Lush chocolate malt with cool mint and a creamy lactose finish — dessert in a glass.','Dark',6.6,7.5,'active','{}',null),
  ('008b789f-a9d2-43ec-ba18-9f483bd5bf37','46','Fairweather Cider Co','Apple Cider','Very dry, tart, and crisp with moderate apple aroma.','Guest Tap',5.5,7,'active','{}',null),
  ('4d644fd7-a792-48aa-a7fc-1c982efe2819','47','Lago''s Finest','Root Beer','House-crafted with vanilla and wintergreen — the best non-alcoholic pour on the list.','Non-Alcoholic',0,4,'active','{}',null);

-- wine_menu is new as of migration_002 — should already be empty, but
-- clear it defensively so this file is safe to re-run.
delete from wine_menu;

insert into wine_menu (id, name, winery, region, type, category, display_group, description, price_glass, price_bottle, badge, status, sort_order) values
  ('c0860769-96c8-4582-b39d-b99d7e0ac22e','Cremant d''Alsace','Lucien Albrecht','Orschwihr, France','Brut Rosé','sparkling','Wine by the Bottle','Fine bubbles with aromas of apple, peach, and a creamy finish',null,30,'{Bottle}','active',1),
  ('4a617261-d94a-497c-8411-7dd44659e33b','Pinot Grigio','Flat Creek Estate','Marble Falls, TX','Pinot Grigio','white','Wine by the Bottle','Ripe pear and citrus with crisp acidity and a clean finish',null,35,'{Bottle}','active',2),
  ('95813edc-1e56-4912-a685-31bfdfe60000','Sparkling Almond','Flat Creek Estate','Marble Falls, TX','Sparkling','sparkling','Wine by the Bottle','Lightly sweet with almond blossom and crisp effervescence',null,30,'{Bottle}','active',3),
  ('82464ef9-2114-4c21-91aa-a567a6507a56','Four Horseman','Flat Creek Estate','Marble Falls, TX','Dry Red','red','Wine by the Bottle','Bold Texas red blend with dark fruit, cedar, and warm leather finish',null,49,'{Bottle}','active',4),
  ('3e160b90-d1c3-4518-943c-2c7f36258ad9','Louis Perdrier Brut','Louis Perdrier','Burgundy, France','Champagne','sparkling','Wine by the Glass','Served straight or brightened with fresh orange juice',6,20,'{Glass+Bottle}','active',5),
  ('10432646-fd69-412b-87f9-5191ddbf10c3','Unoaked Chardonnay','La Playa','Colchagua Valley, Chile','Chardonnay','white','Wine by the Glass','Crisp with green apple, citrus, and a clean finish',8,25,'{Glass+Bottle}','active',6),
  ('e8408561-043a-4b91-87a8-d638cce6d998','Tortoise Creek Sauvignon Blanc','Tortoise Creek','Lodi, California','Sauvignon Blanc','white','Wine by the Glass','Bright and zesty with herbaceous notes and lively citrus',8,25,'{Glass+Bottle}','active',7),
  ('f0f92eb6-7a3c-4599-99fb-8c0cb8843dbf','Prickly Rose','Frisk','Victoria, Australia','Riesling','white','Wine by the Glass','Off-dry and aromatic with peach, apricot, and a touch of sweetness',8,25,'{Glass+Bottle}','active',8),
  ('7cf5e216-1ab1-48e4-8194-31ba6840cb43','Comtesse Marion Cabernet Sauvignon','Comtesse Marion','Languedoc-Roussillon, France','Cabernet Sauvignon','red','Wine by the Glass','Full-bodied with dark fruit, cedar, and smooth tannins',8,25,'{Glass+Bottle}','active',9),
  ('b64b4a05-2d46-41d7-bb15-7adfe604551c','Sway Rosé','William Chris','Fredericksburg, TX','Dry Rosé','rosé','Wine by the Glass','Texas High Plains canned rosé with guava, strawberry, and a crisp finish',null,9,'{Can}','active',10),
  ('2bed1978-c352-4d28-8967-47eb38ffd81e','Upside Dawn','Athletic',null,'Golden Ale','na','N/A Beer','Crisp and light-bodied with citrus, herbs, and earthy hop aroma · <0.5% ABV · 50 cal',null,5,'{Can}','active',11),
  ('dd48e6f1-c617-4bd7-81d6-83fec53b4176','Run Wild IPA','Athletic',null,'IPA','na','N/A Beer','Five Northwest hops, piney citrus nose, approachable bitterness · <0.5% ABV · 70 cal',null,5,'{Can}','active',12),
  ('7fb3acc1-e6f5-4db8-88ec-552388d8d5ac','Athletic Lite','Athletic',null,'Light Lager','na','N/A Beer','Crisp, clean, and crushable with noble hops and a rice-malt body · <0.5% ABV · 25 cal',null,5,'{Can}','active',13),
  ('002d5526-e1f6-49f7-87cc-145d5d33d48d','Lago''s Finest','Lago Vista Brewing Company',null,'Root Beer','na','N/A Options','House-crafted root beer',null,4,'{}','active',14),
  ('175363c5-5823-48f6-a2fc-038ec5ff69dc','Canned Soda',null,null,null,'na','N/A Options','Coke · Diet Coke · Dr Pepper · Diet Dr Pepper · Sprite · Canada Dry',null,2,'{Can}','active',15),
  ('ade2ac42-9d28-4f5b-8641-c29ea9fb450d','Iced Tea','Gold Peak',null,null,'na','N/A Options','Sweet or Unsweet',null,3,'{Bottle}','active',16),
  ('d470ac77-ad21-4640-a848-486b9593a7d3','Lemonade',null,null,null,'na','N/A Options',null,null,4,'{}','active',17),
  ('8176b278-49d8-4be4-a893-3adfe2d6508a','Sparkling Mineral Water','Mineragua',null,null,'na','N/A Options','12.5 oz bottle',null,3,'{Bottle}','active',18),
  ('fb85d5e1-eb94-45ff-acee-f8870464ea00','Juice Box','Apple & Eve',null,null,'na','N/A Options','Apple, White Grape Raspberry, Fruit Punch',null,1,'{}','active',19);
