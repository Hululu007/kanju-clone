select (select count(*) from shows) as shows, (select count(*) from episodes) as eps;
